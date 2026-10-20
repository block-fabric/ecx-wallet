// The core modules as they ship: each `.wasm` in the extension build, loaded through the wallet's
// hand-written glue exactly as the background loads it (no browser needed).
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import * as esbuild from "esbuild";
import { DIST, ROOT } from "../harness.mjs";

const ABANDON = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

/** The wallet's TypeScript glue, bundled for node the way esbuild bundles it for the background. */
async function importWallet() {
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, "wallet", "src", "index.ts")],
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
}

test("every shipped .wasm imports nothing but memory", async () => {
  const wasm = (await readdir(DIST.chromium)).filter((f) => f.endsWith(".wasm"));
  assert.ok(wasm.includes("vault.wasm"), "vault.wasm is packaged");
  for (const file of wasm) {
    const module = new WebAssembly.Module(await readFile(path.join(DIST.chromium, file)));
    const imports = WebAssembly.Module.imports(module).filter((i) => i.kind !== "memory");
    assert.deepEqual(imports, [], `${file} imports more than memory`);
  }
});

test("the shipped Vault yields the BitWindow Slot 24 Starters, with and without a passphrase", async () => {
  const { loadVaultModule } = await importWallet();
  const vault = await loadVaultModule(await readFile(path.join(DIST.chromium, "vault.wasm")));
  assert.equal(vault.starter(ABANDON, "", 24), "buyer citizen congress doll secret merry denial law live wait pass drive");
  assert.equal(vault.starter(ABANDON, "TREZOR", 24), "raw sister combine impact penalty improve soap power tomato topic frog flip");
});

test("the shipped Vault creates from caller entropy, checks imports and stretches passwords", async () => {
  const { loadVaultModule } = await importWallet();
  const vault = await loadVaultModule(await readFile(path.join(DIST.chromium, "vault.wasm")));
  assert.equal(vault.masterMnemonicFromEntropy(new Uint8Array(16)), ABANDON);
  assert.equal(vault.canonicalMnemonic(`  ${ABANDON.toUpperCase()} `), ABANDON);
  assert.throws(() => vault.canonicalMnemonic("abandon abandon"), /word count|invalid/i);
  const key = vault.stretchPassword(
    new TextEncoder().encode("password"),
    new TextEncoder().encode("somesaltsomesalt"),
    { mKib: 65536, t: 3, p: 1 },
  );
  assert.equal(Buffer.from(key).toString("hex"), "7664ad4ba1a3c999fcdd0991ffc2270f78302d2383233db5e7befc85d1bb1819");
});
