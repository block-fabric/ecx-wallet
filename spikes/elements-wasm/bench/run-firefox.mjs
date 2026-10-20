// Firefox runs: (a) plain web page, (c) MV3 background script (event page), cold start each iteration.
// Each iteration temporarily installs the variant's extension (WebDriver BiDi webExtension.install);
// its background script runs the bench on startup and POSTs the result to the local server.
// Usage: node run-firefox.mjs [N=9] [headless=true|false]
import puppeteer from "puppeteer-core";
import { rmSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startServer } from "./server.mjs";
import { summarize } from "./stats.mjs";
import { RESULT_PORT } from "./assemble-const.mjs";

const N = Number(process.argv[2] ?? 9);
const headless = (process.argv[3] ?? "true") !== "false";
const VARIANTS = (process.env.VARIANTS ?? "core,core-lowmem,elementsplus,lwk_wasm").split(",");
const here = new URL(".", import.meta.url);
const profile = fileURLToPath(new URL(".profile-firefox", here));
rmSync(profile, { recursive: true, force: true });
mkdirSync(profile);

let waiter = null;
const server = await startServer(new URL("out/firefox/", here), (r) => waiter?.(r));
const nextResult = () => new Promise((ok, fail) => {
  const timer = setTimeout(() => fail(new Error("no result in 60s")), 60000);
  waiter = (r) => { clearTimeout(timer); waiter = null; ok(r); };
});

const browser = await puppeteer.launch({
  browser: "firefox",
  executablePath: process.env.FIREFOX ?? "/usr/bin/firefox",
  headless,
  userDataDir: profile,
  dumpio: !!process.env.DEBUG,
  // When launched from VS Code's snap, GTK_PATH/GIO_MODULE_DIR/... point into /snap and Firefox's
  // content processes die with a glibc symbol error. Drop those variables.
  env: Object.fromEntries(Object.entries(process.env).filter(([k, v]) => !/\/snap\//.test(v) && !k.startsWith("SNAP"))),
});
const version = await browser.version();
console.log("browser:", version);
const results = { browser: version, n: N, web: {}, bg: {} };

for (const v of VARIANTS) {
  const runs = [];
  for (let i = 0; i < N; i++) {
    const page = await browser.newPage();
    await page.setCacheEnabled(false).catch(() => {});
    await page.goto(`http://127.0.0.1:${RESULT_PORT}/${v}/index.html`);
    await page.waitForFunction("window.__result", { timeout: 60000 });
    const r = await page.evaluate("window.__result");
    await page.close();
    if (!r.ok) throw new Error(v + ": " + r.error);
    runs.push({ ...r.t, evalAt: r.evalAt });
  }
  results.web[v] = summarize(runs);
  console.log("web", v, JSON.stringify(results.web[v]));
}

for (const v of VARIANTS) {
  const dir = fileURLToPath(new URL(`out/firefox/${v}`, here));
  const runs = [];
  for (let i = 0; i < N; i++) {
    const got = nextResult();
    const t0 = performance.now();
    const id = await browser.installExtension(dir);
    const r = await got;
    const installToResult = performance.now() - t0;
    await browser.uninstallExtension(id);
    if (!r.ok) throw new Error(v + ": " + r.error);
    // evalAt: background timeOrigin -> top-level evaluated; doneAt: -> bench finished.
    runs.push({ ...r.t, evalAt: r.evalAt, doneAt: r.doneAt, installToResult });
  }
  results.bg[v] = summarize(runs);
  console.log("bg", v, JSON.stringify(results.bg[v]));
}

await browser.close();
server.close();
writeFileSync(new URL("out/results-firefox.json", here), JSON.stringify(results, null, 1));
