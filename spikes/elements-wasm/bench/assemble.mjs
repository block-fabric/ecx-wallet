// Lays out one self-contained directory per variant, usable as: a web root (index.html),
// an unpacked Chrome MV3 extension (out/chrome/<v>) and a Firefox MV3 extension (out/firefox/<v>).
import { cpSync, mkdirSync, rmSync, writeFileSync, readdirSync } from "node:fs";

const here = new URL(".", import.meta.url);
const rel = (p) => new URL(p, here);
// Prior-art artifact (read-only; only copied): set EP_WASM_DIR if it lives elsewhere.
const EP = process.env.EP_WASM_DIR ?? "/run/media/marcus/f447849b-3be4-4c58-a1c6-baeec8b030ac/newer_code/elementsplus-wallet-extension/dist/chromium/src/wasm/";
import { RESULT_PORT } from "./assemble-const.mjs";

const variants = {
  core: { from: rel("../pkg/"), files: ["spike_core_wasm.js", "spike_core_wasm_bg.wasm"],
    entry: `import init, * as m from "./glue/spike_core_wasm.js";
import { runCore } from "./bench-lib.js";
export const wasmUrl = new URL("./glue/spike_core_wasm_bg.wasm", import.meta.url).href;
export const run = (fixture, src = wasmUrl) => runCore(m, init, src, fixture);` },
  "core-lowmem": { from: rel("../pkg-lowmem/"), files: ["spike_core_wasm.js", "spike_core_wasm_bg.wasm"], entryFrom: "core" },
  elementsplus: { from: new URL("file://" + EP), files: ["elementsplus_wallet_core.js", "elementsplus_wallet_core_bg.wasm"],
    entry: `import init, * as m from "./glue/elementsplus_wallet_core.js";
import { runEp } from "./bench-lib.js";
export const wasmUrl = new URL("./glue/elementsplus_wallet_core_bg.wasm", import.meta.url).href;
export const run = (fixture, src = wasmUrl) => runEp(m, init, src, fixture);` },
  lwk_wasm: { from: rel("node_modules/lwk_wasm/"), files: ["lwk_wasm_bg.js", "lwk_wasm_bg.wasm"],
    entry: `import * as m from "./glue/lwk_wasm_bg.js";
import { runLwk } from "./bench-lib.js";
export const wasmUrl = new URL("./glue/lwk_wasm_bg.wasm", import.meta.url).href;
export const run = (fixture, src = wasmUrl) => runLwk(m, src, fixture);` },
};

const CSP = "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'";

// Chrome MV3 service worker: listeners registered synchronously, lazy work inside the handler,
// no top-level await. T0 = ms from worker start (timeOrigin) to top-level evaluation.
const SW = `const T0 = performance.now();
import { run } from "./entry.js";
import fixture from "./fixture.js";
let pending = null;
let served = 0;
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.cmd !== "bench") return false;
  const msgAt = performance.now();
  pending ??= run(fixture);
  pending.then(
    (t) => reply({ ok: true, t, evalAt: T0, msgAt, doneAt: performance.now(), served: served++ }),
    (e) => reply({ ok: false, error: String(e && e.stack || e) }));
  return true;
});
`;

// Firefox MV3 background (event page): runs once on startup, reports to the local harness.
const FF_BG = `const T0 = performance.now();
import { run } from "./entry.js";
import fixture from "./fixture.js";
run(fixture).then(
  (t) => ({ ok: true, t, evalAt: T0, doneAt: performance.now(), ua: navigator.userAgent }),
  (e) => ({ ok: false, error: String(e && e.stack || e) }))
  .then((r) => fetch("http://127.0.0.1:${RESULT_PORT}/result", { method: "POST", body: JSON.stringify(r) }));
`;

const PAGE_HTML = `<!doctype html><meta charset="utf-8"><title>bench</title><script type="module" src="page.js"></script>`;
const PAGE_JS = `window.ask = () => chrome.runtime.sendMessage({ cmd: "bench" });`;
const WEB_HTML = `<!doctype html><meta charset="utf-8"><title>bench</title><script type="module" src="web.js"></script>`;
const WEB_JS = `import { run } from "./entry.js";
import fixture from "./fixture.js";
const evalAt = performance.now();
run(fixture).then((t) => { window.__result = { ok: true, t, evalAt, doneAt: performance.now() }; },
  (e) => { window.__result = { ok: false, error: String(e && e.stack || e) }; });
`;

rmSync(rel("out/chrome"), { recursive: true, force: true });
rmSync(rel("out/firefox"), { recursive: true, force: true });
for (const [name, v] of Object.entries(variants)) {
  for (const browser of ["chrome", "firefox"]) {
    const dir = rel(`out/${browser}/${name}/`);
    mkdirSync(new URL("glue/", dir), { recursive: true });
    for (const f of v.files) cpSync(new URL(f, v.from), new URL("glue/" + f, dir));
    cpSync(rel("src/bench-lib.js"), new URL("bench-lib.js", dir));
    cpSync(rel("out/fixture.js"), new URL("fixture.js", dir));
    writeFileSync(new URL("entry.js", dir), v.entry ?? variants[v.entryFrom].entry);
    writeFileSync(new URL("index.html", dir), WEB_HTML);
    writeFileSync(new URL("web.js", dir), WEB_JS);
    const base = { manifest_version: 3, name: `bench-${name}`, version: "0.0.1",
      content_security_policy: { extension_pages: CSP } };
    if (browser === "chrome") {
      writeFileSync(new URL("manifest.json", dir), JSON.stringify({ ...base,
        background: { service_worker: "sw.js", type: "module" } }, null, 1));
      writeFileSync(new URL("sw.js", dir), SW);
      writeFileSync(new URL("page.html", dir), PAGE_HTML);
      writeFileSync(new URL("page.js", dir), PAGE_JS);
    } else {
      writeFileSync(new URL("manifest.json", dir), JSON.stringify({ ...base,
        background: { scripts: ["bg.js"], type: "module" },
        browser_specific_settings: { gecko: { id: `bench-${name}@spike.invalid` } } }, null, 1));
      writeFileSync(new URL("bg.js", dir), FF_BG);
    }
  }
}
console.log("assembled", readdirSync(rel("out/chrome")).join(", "));
