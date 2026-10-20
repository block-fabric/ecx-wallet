// Seam 1 harness: the built extension in headless Brave, driven from outside.
//
// - puppeteer-core only, no Chrome download. Browser binary: $BRAVE, default /usr/bin/brave.
// - Throwaway profile in a fresh temp dir, deleted on close; never the user's profile.
// - Puppeteer never attaches to the extension's service worker (`targetFilter`): an attached
//   debugger keeps a stopped worker from restarting (see spike/elements-wasm RESULTS.md).
//   Tests that need to stop the worker should do it over a page's CDP session with
//   `ServiceWorker.stopWorker`, as the spike did.
import { mkdtemp, rm, readFile } from "node:fs/promises";
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

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Launches headless Brave with the built Chromium extension installed.
 * Returns a session; always `await session.close()` (use `t.after` / try-finally).
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
    await browser.close();
    await rm(profile, { recursive: true, force: true });
    throw error;
  }

  const extensionOrigin = `chrome-extension://${extensionId}`;
  return {
    browser,
    extensionId,
    extensionUrl: (p) => `${extensionOrigin}/${p.replace(/^\//, "")}`,

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

    /** Resolves with the next approval window the wallet opens. */
    async waitForApprovalWindow({ timeout = 10_000 } = {}) {
      const target = await browser.waitForTarget(
        (t) => t.url().startsWith(`${extensionOrigin}/`) && t.url().includes("#/approve/"),
        { timeout },
      );
      const page = await target.asPage();
      await page.waitForSelector("[data-approval-ready]", { timeout });
      return page;
    },

    /** Open approval windows right now (for asserting that none was opened). */
    async approvalWindows() {
      return browser.targets().filter(
        (t) => t.url().startsWith(`${extensionOrigin}/`) && t.url().includes("#/approve/"),
      );
    },

    async close() {
      await browser.close().catch(() => {});
      await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
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
 * `url(host)` lets a test load the same app from a second origin (e.g. "localhost").
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
    url: (host = "127.0.0.1") => `http://${host}:${port}/`,
    origin: (host = "127.0.0.1") => `http://${host}:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Opens the test app in a new tab and waits until its script is ready. */
export async function openTestApp(session, app, host) {
  const page = await session.browser.newPage();
  await page.goto(app.url(host));
  await page.waitForFunction(() => window.testApp !== undefined);
  return page;
}

export { delay };
