// Brave (Chromium) runs: (a) plain web page, (b) MV3 service worker cold wake.
// Usage: node run-brave.mjs [N=9] [headless=new|false]
// Uses a throwaway profile under bench/.profile-brave (deleted first); never the user's profile.
import puppeteer from "puppeteer-core";
import { rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startServer } from "./server.mjs";
import { summarize } from "./stats.mjs";
import { RESULT_PORT } from "./assemble-const.mjs";

const N = Number(process.argv[2] ?? 9);
const headless = (process.argv[3] ?? "true") !== "false";
const VARIANTS = (process.env.VARIANTS ?? "core,core-lowmem,elementsplus,lwk_wasm").split(",");
const here = new URL(".", import.meta.url);
const profile = fileURLToPath(new URL(".profile-brave", here));
rmSync(profile, { recursive: true, force: true });
const extDirs = VARIANTS.map((v) => fileURLToPath(new URL(`out/chrome/${v}`, here)));

const server = await startServer(new URL("out/chrome/", here));
const browser = await puppeteer.launch({
  executablePath: process.env.BRAVE ?? "/usr/bin/brave",
  headless,
  userDataDir: profile,
  enableExtensions: extDirs,
  // Never auto-attach to service workers: an attached debugger makes a restarted worker wait for it
  // (observed: after a stop, the next message never got a reply), and it would also block idle termination.
  targetFilter: (t) => t.type() !== "service_worker",
  args: ["--no-first-run", "--no-default-browser-check", "--disable-features=BraveRewards,BraveWallet"],
});
const version = await browser.version();
console.log("browser:", version);
const results = { browser: version, n: N, web: {}, sw: {}, swRoundTrip: {} };

// ---- (a) plain web page, HTTP cache disabled, fresh tab per iteration ----
// Also once with 4x CPU throttling (DevTools emulation) as a rough low-end-device proxy.
for (const rate of process.env.SKIP_WEB ? [] : [1, 4]) {
  const key = rate === 1 ? "web" : `web${rate}x`;
  results[key] ??= {};
  for (const v of VARIANTS) {
    const runs = [];
    for (let i = 0; i < N; i++) {
      const page = await browser.newPage();
      await page.setCacheEnabled(false);
      if (rate !== 1) await (await page.createCDPSession()).send("Emulation.setCPUThrottlingRate", { rate });
      await page.goto(`http://127.0.0.1:${RESULT_PORT}/${v}/index.html`);
      await page.waitForFunction("window.__result", { timeout: 60000 });
      const r = await page.evaluate("window.__result");
      await page.close();
      if (!r.ok) throw new Error(v + ": " + r.error);
      runs.push({ ...r.t, evalAt: r.evalAt });
    }
    results[key][v] = summarize(runs);
    console.log(key, v, JSON.stringify(results[key][v]));
  }
}

// ---- (b) MV3 service worker, cold wake each iteration ----
// Unpacked extension id = first 32 hex digits of sha256(absolute path), mapped 0-f -> a-p.
// (Computed instead of attaching to the worker: puppeteer must never attach to the SW, see below.)
const ids = Object.fromEntries(VARIANTS.map((v, i) => [v, createHash("sha256").update(extDirs[i]).digest("hex")
  .slice(0, 32).replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)))]));
console.log("extensions:", ids);

const cdp = await browser.target().createCDPSession();
let pageCdp = null;
async function stopWorker(id) {
  if (process.env.NOSTOP) return;
  // Terminates the worker like DevTools' "Stop" button (same path as the idle timeout).
  // Whether it really restarted is checked from the reply (`served === 0` means a fresh instance).
  const running = [...versions.values()].filter((v) => v.scriptURL.includes(id) && v.runningStatus !== "stopped");
  if (process.env.STOP_MODE === "all") await pageCdp.send("ServiceWorker.stopAllWorkers");
  else for (const v of running) await pageCdp.send("ServiceWorker.stopWorker", { versionId: v.versionId });
  for (let i = 0; i < 50; i++) {
    const still = [...versions.values()].filter((v) => v.scriptURL.includes(id) && v.runningStatus !== "stopped");
    if (!still.length) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 300));
}
const versions = new Map();

for (const v of VARIANTS) {
  const id = ids[v];
  const page = await browser.newPage();
  for (let i = 0; ; i++) { // the extension may still be loading right after launch
    try { await page.goto(`chrome-extension://${id}/page.html`); break; }
    catch (e) { if (i > 50) throw e; await new Promise((r) => setTimeout(r, 200)); }
  }
  pageCdp = await page.createCDPSession();
  pageCdp.on("ServiceWorker.workerVersionUpdated", ({ versions: vs }) => {
    for (const x of vs) versions.set(x.versionId, x);
  });
  await pageCdp.send("ServiceWorker.enable");
  await new Promise((r) => setTimeout(r, 300));
  if (process.env.DEBUG) console.log([...versions.values()]);
  const runs = [];
  const trips = [];
  // i = -1: the worker instance started at browser launch/extension install (first-ever wasm compile,
  // no code cache). Recorded separately; i >= 0 are stop -> message cold wakes.
  for (let i = -1; i < N; i++) {
    if (i >= 0) await stopWorker(id);
    const r = await page.evaluate(async () => {
      const t0 = performance.now();
      const r = await Promise.race([window.ask(),
        new Promise((ok) => setTimeout(() => ok({ ok: false, error: "no reply in 20s" }), 20000))]);
      return { ...r, trip: performance.now() - t0 };
    });
    if (!r?.ok) throw new Error(v + ": " + (r?.error ?? "no reply"));
    if (process.env.DEBUG) console.log("served", r.served, "evalAt", r.evalAt, "versions", [...versions.values()].map((x) => x.runningStatus));
    if (!process.env.NOSTOP && r.served !== 0) throw new Error(`${v}: worker was not restarted (served=${r.served})`);
    // evalAt: worker start -> top-level evaluated (module graph incl. glue parsed);
    // msgAt: worker start -> message handler entered; doneAt: worker start -> reply sent.
    const sample = { ...r.t, evalAt: r.evalAt, msgAt: r.msgAt, doneAt: r.doneAt, wakeToReply: r.trip };
    if (i < 0) { (results.swInstall ??= {})[v] = sample; continue; }
    runs.push({ ...r.t, evalAt: r.evalAt, msgAt: r.msgAt, doneAt: r.doneAt });
    trips.push({ wakeToReply: r.trip });
  }
  await page.close();
  results.sw[v] = summarize(runs);
  results.swRoundTrip[v] = summarize(trips);
  console.log("sw", v, JSON.stringify(results.sw[v]), "roundtrip", JSON.stringify(results.swRoundTrip[v]));
}

await browser.close();
server.close();
writeFileSync(new URL("out/results-brave.json", here), JSON.stringify(results, null, 1));
