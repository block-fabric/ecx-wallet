// The e2e build: the shipped extension with one change, Slot 24's betanet Sidechain Server, which
// points at the stub Esplora server on loopback (`E2E_SIDECHAIN_SERVER`). Everything else comes
// from the same sources, so build-output.test can check the two builds differ only there.
//
//   e2e/dist/chain-entry.json   the shipped Chain Entry with the stub as betanet's server
//   e2e/dist/core/              core modules; elements.wasm embeds that Chain Entry
//   e2e/dist/extension/chromium/, firefox/
//
// Run after the shipped build (it reuses the app build): the root `pnpm test` does.
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Betanet's Sidechain Server in the e2e build: harness.mjs serves the Esplora stub here. */
export const E2E_SIDECHAIN_SERVER = { api: "esplora", url: "http://127.0.0.1:24024" };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const out = path.join(root, "e2e", "dist");

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const entry = JSON.parse(await readFile(path.join(root, "core", "elements", "chain-entry.json"), "utf8"));
  entry.networks.betanet.sidechainServer = E2E_SIDECHAIN_SERVER;
  await mkdir(out, { recursive: true });
  const chainEntry = path.join(out, "chain-entry.json");
  await writeFile(chainEntry, `${JSON.stringify(entry, null, 2)}\n`);

  const run = (dir, env) =>
    execFileSync("node", ["scripts/build.mjs"], { cwd: path.join(root, dir), stdio: "inherit", env: { ...process.env, ...env } });
  const coreDist = path.join(out, "core");
  // Its own cargo target dir, so the shipped and e2e builds don't keep rebuilding each other.
  run("core", { ECX_ELEMENTS_CHAIN_ENTRY: chainEntry, ECX_CORE_DIST: coreDist, CARGO_TARGET_DIR: path.join(root, "core", "target", "e2e") });
  run("extension", { ECX_CORE_DIST: coreDist, ECX_CHAIN_ENTRIES: chainEntry, ECX_EXTENSION_DIST: path.join(out, "extension") });
}
