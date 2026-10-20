// The build's own gates fail the build when they should (they pass on today's output, which the
// build itself proves; these check they would catch a regression).
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkWasmImports } from "../../core/scripts/check-wasm-imports.mjs";
import { checkNoEval } from "../../extension/scripts/check-no-eval.mjs";

const HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
// (import "env" "f" (func)) with its type section.
const IMPORTS_A_FUNCTION = new Uint8Array([
  ...HEADER,
  0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
  0x02, 0x09, 0x01, 0x03, 0x65, 0x6e, 0x76, 0x01, 0x66, 0x00, 0x00,
]);
// (import "env" "m" (memory 1))
const IMPORTS_ONLY_MEMORY = new Uint8Array([
  ...HEADER,
  0x02, 0x0a, 0x01, 0x03, 0x65, 0x6e, 0x76, 0x01, 0x6d, 0x02, 0x00, 0x01,
]);

test("the WASM gate rejects a module that imports anything but memory", () => {
  assert.throws(() => checkWasmImports("bad.wasm", IMPORTS_A_FUNCTION), /bad\.wasm imports more than memory: env\.f/);
  checkWasmImports("ok.wasm", IMPORTS_ONLY_MEMORY);
  checkWasmImports("empty.wasm", new Uint8Array(HEADER));
});

for (const [what, source] of [
  ["eval", "const x = eval('1 + 1');"],
  ["new Function", "const f = new Function('return 1');"],
]) {
  test(`the glue gate fails the build when a shipped script contains ${what}`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ecx-gate-"));
    try {
      await writeFile(path.join(dir, "clean.js"), "export const evaluate = (fn) => fn(); // evaluated later\n");
      await checkNoEval(dir);
      await writeFile(path.join(dir, "glue.js"), source);
      await assert.rejects(checkNoEval(dir), /Runtime code loading in shipped scripts: glue\.js/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
