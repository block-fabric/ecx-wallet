// Raw / gzip -9 / brotli q11 sizes of each variant's .wasm and JS glue.
import { readFileSync, readdirSync } from "node:fs";
import { gzipSync, brotliCompressSync, constants } from "node:zlib";
const root = new URL("out/chrome/", import.meta.url);
const rows = [];
for (const v of readdirSync(root)) {
  for (const f of readdirSync(new URL(`${v}/glue/`, root))) {
    const b = readFileSync(new URL(`${v}/glue/${f}`, root));
    rows.push({ variant: v, file: f, raw: b.length,
      gzip: gzipSync(b, { level: 9 }).length,
      brotli: brotliCompressSync(b, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length });
  }
}
console.table(rows);
console.log(JSON.stringify(rows));
