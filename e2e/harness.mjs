// Seam 1 harness: the built extension in a real headless browser, driven from outside.
//
// - puppeteer-core only, no Chrome download. Binaries: $BRAVE (default /usr/bin/brave),
//   $FIREFOX (default /usr/bin/firefox).
// - Throwaway profile in a fresh temp dir, deleted on close; never the user's profile.
// - Puppeteer never attaches to the extension's service worker (`targetFilter`): an attached
//   debugger keeps a stopped worker from restarting (see spike/elements-wasm RESULTS.md).
//   Tests that need to stop the worker should do it over a page's CDP session with
//   `ServiceWorker.stopWorker`, as the spike did.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import puppeteer from "puppeteer-core";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..");
export const DIST = {
  chromium: path.join(ROOT, "extension", "dist", "chromium"),
  firefox: path.join(ROOT, "extension", "dist", "firefox"),
};

/** Browsers the Provider suite runs against: `E2E_BROWSERS=brave,firefox` (the default). */
export const BROWSERS = (process.env.E2E_BROWSERS ?? "brave,firefox").split(",").filter(Boolean);

/** Launches the named browser (one of BROWSERS) with the matching extension build installed. */
export function launchWallet(name) {
  if (name === "brave") return launchBrave();
  if (name === "firefox") return launchFirefox();
  throw new Error(`Unknown browser ${name}`);
}

/**
 * Launches headless Brave with the built Chromium extension installed.
 * Returns a session; always `await session.close()`.
 */
export async function launchBrave({ extensionPath = DIST.chromium } = {}) {
  const profile = await mkdtemp(path.join(tmpdir(), "ecx-e2e-brave-"));
  const browser = await puppeteer.launch({
    executablePath: process.env.BRAVE ?? "/usr/bin/brave",
    headless: process.env.HEADFUL ? false : true,
    pipe: true,
    enableExtensions: true,
    userDataDir: profile,
    targetFilter: (target) => target.type() !== "service_worker",
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--disable-features=BraveRewards,BraveWallet,BraveNews",
      // Every *.localhost name is the test server, so each test can use its own web origin
      // (Grants are per origin) while staying a secure context.
      "--host-resolver-rules=MAP *.localhost 127.0.0.1",
    ],
  });
  let extensionId;
  try {
    // Developer mode turns on the extension error console, so runtime errors (CSP violations,
    // uncaught exceptions) are recorded and `extensionErrors()` can report them.
    await withExtensionsPage(browser, (page) =>
      page.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true })),
    );
    extensionId = await browser.installExtension(extensionPath);
  } catch (error) {
    await closeBrowser(browser, profile);
    throw error;
  }

  return {
    ...walletSession(browser, profile, `chrome-extension://${extensionId}/`),
    extensionId,

    /** Manifest errors, install warnings and runtime errors Brave recorded for the extension. */
    async extensionErrors() {
      const info = await withExtensionsPage(browser, (page) =>
        page.evaluate((id) => chrome.developerPrivate.getExtensionInfo(id), extensionId),
      );
      return {
        manifestErrors: info.manifestErrors ?? [],
        installWarnings: info.installWarnings ?? [],
        runtimeErrors: info.runtimeErrors ?? [],
      };
    },
  };
}

/**
 * Launches headless Firefox over WebDriver BiDi with the built Firefox extension temporarily
 * installed. Same session shape as Brave's, minus `extensionErrors` (no equivalent API).
 */
// Pins the Firefox extension's internal UUID so tests can open its pages (moz-extension://<uuid>/).
const FIREFOX_EXTENSION_ID = "wallet@ecx.invalid";
const FIREFOX_EXTENSION_UUID = "6c1f6e1e-ec0a-4c1b-9a51-ec0000000024";

export async function launchFirefox({ extensionPath = DIST.firefox } = {}) {
  const profile = await mkdtemp(path.join(tmpdir(), "ecx-e2e-firefox-"));
  const browser = await puppeteer.launch({
    browser: "firefox",
    executablePath: process.env.FIREFOX ?? "/usr/bin/firefox",
    headless: process.env.HEADFUL ? false : true,
    userDataDir: profile,
    extraPrefsFirefox: {
      "extensions.webextensions.uuids": JSON.stringify({ [FIREFOX_EXTENSION_ID]: FIREFOX_EXTENSION_UUID }),
    },
    // Needed to script moz-extension:// pages such as the approval window.
    args: ["-remote-allow-system-access"],
    // A snap-launched parent (e.g. VS Code) leaks GTK/GIO paths that crash Firefox's content
    // processes (spike/elements-wasm RESULTS.md); drop them.
    env: Object.fromEntries(
      Object.entries(process.env).filter(([k, v]) => !/\/snap\//.test(v ?? "") && !k.startsWith("SNAP")),
    ),
  });
  try {
    await browser.installExtension(extensionPath);
  } catch (error) {
    await closeBrowser(browser, profile);
    throw error;
  }
  return walletSession(browser, profile, `moz-extension://${FIREFOX_EXTENSION_UUID}/`);
}

/** What every browser session offers. `walletPrefix` identifies the wallet's own pages. */
function walletSession(browser, profile, walletPrefix) {
  const isApproval = (t) => t.url().startsWith(walletPrefix) && t.url().includes("#/approve/");
  // Over BiDi (Firefox), puppeteer neither reliably reports windows an extension opens nor drops
  // them from `targets()` once closed, so poll and probe each candidate for liveness.
  const dead = new WeakSet();
  async function liveApprovals() {
    const live = [];
    for (const target of browser.targets().filter((t) => isApproval(t) && !dead.has(t))) {
      const page = await target.asPage();
      const alive = await Promise.race([
        page.evaluate(() => true).catch(() => false),
        new Promise((r) => setTimeout(() => r(false), 2_000)),
      ]);
      if (alive) live.push(page);
      else dead.add(target);
    }
    return live;
  }

  return {
    browser,
    extensionUrl: (p) => `${walletPrefix}${p.replace(/^\//, "")}`,

    /** Resolves with the next approval window the wallet opens, once it has rendered. */
    async waitForApprovalWindow({ timeout = 10_000 } = {}) {
      for (const end = Date.now() + timeout; ; await new Promise((r) => setTimeout(r, 100))) {
        const [page] = await liveApprovals();
        if (page) {
          await page.waitForSelector("[data-approval-ready]", { timeout });
          return page;
        }
        if (Date.now() > end) throw new Error(`No approval window within ${timeout} ms`);
      }
    },

    /** Approval windows open right now (to assert that none was opened). */
    approvalWindows: liveApprovals,

    close: () => closeBrowser(browser, profile),
  };
}

async function closeBrowser(browser, profile) {
  await browser.close().catch(() => {});
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

async function withExtensionsPage(browser, fn) {
  const page = await browser.newPage();
  try {
    await page.goto("chrome://extensions");
    await page.waitForFunction(() => typeof chrome?.developerPrivate !== "undefined");
    return await fn(page);
  } finally {
    await page.close();
  }
}

/**
 * Serves the test Sidechain App (e2e/test-app) on 127.0.0.1, with the `client` library bundled in.
 * `url(host)` / `origin(host)` give the app under any `<name>.localhost` host, each its own origin.
 */
export async function serveTestApp() {
  const bundle = await esbuild.build({
    entryPoints: [path.join(here, "test-app", "app.js")],
    bundle: true,
    format: "esm",
    write: false,
  });
  const appJs = bundle.outputFiles[0].text;
  const html = await readFile(path.join(here, "test-app", "index.html"), "utf8");
  const server = createServer((request, response) => {
    if (request.url === "/app.js") {
      response.writeHead(200, { "Content-Type": "text/javascript" });
      response.end(appJs);
    } else {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: (host = "app.localhost") => `http://${host}:${port}/`,
    origin: (host = "app.localhost") => `http://${host}:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Opens a wallet screen (a hash route of the app, e.g. `#/grants`) in a new tab, once rendered. */
export async function openWalletPage(session, route) {
  const page = await session.browser.newPage();
  // Over BiDi (Firefox) the navigation to a moz-extension:// page never reports completion, though
  // the page loads; so wait for the screen itself rather than for goto.
  page.goto(session.extensionUrl(`index.html${route}`)).catch(() => {});
  await page.waitForSelector("[data-screen-ready]");
  return page;
}

/** Opens the test app in a new tab and waits until its script is ready. */
export async function openTestApp(session, app, host) {
  const page = await session.browser.newPage();
  await page.goto(app.url(host));
  await page.waitForFunction(() => window.testApp !== undefined);
  return page;
}
