// Sanity check + reference timings in Node (V8, same engine as Chrome/Brave). Fresh process per run.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { median, summarize } from "./stats.mjs";

const [variant, n] = process.argv.slice(2);
if (variant === "--child") {
  const v = process.argv[4];
  const dir = new URL(`out/chrome/${v}/`, import.meta.url);
  const { run, wasmUrl } = await import(new URL("entry.js", dir));
  const fixture = (await import(new URL("fixture.js", dir))).default;
  const bytes = readFileSync(new URL(wasmUrl));
  // Node can't fetch file:// URLs; time compile from bytes (read time excluded).
  const t = await run(fixture, bytes);
  process.stdout.write(JSON.stringify(t));
} else {
  const N = Number(n ?? 7);
  const variants = variant && variant !== "all" ? [variant] : ["core", "core-lowmem", "elementsplus", "lwk_wasm"];
  const out = {};
  for (const v of variants) {
    const runs = [];
    for (let i = 0; i < N; i++) {
      const r = spawnSync(process.execPath, [new URL(import.meta.url).pathname, "--child", "x", v], { encoding: "utf8" });
      if (r.status !== 0) { console.error(v, r.stderr); break; }
      runs.push(JSON.parse(r.stdout));
    }
    out[v] = summarize(runs);
    console.log(v, JSON.stringify(out[v]));
  }
}
