// Builds the extension for every browser from one source:
//   dist/chromium/  and  dist/firefox/
// Everything except manifest.json is built once into a staging dir and copied byte-for-byte into
// each target, so both browsers ship identical code (and, later, identical WASM).
//
// Inputs: the SvelteKit pages from ../app/build and the core modules' .wasm from ../core/dist (run
// those builds first; the root `pnpm build` does all three), and the plain-script entry points in
// src/ bundled with esbuild. Fails if any shipped script contains `eval(` or `new Function(`.
//
// The manifests are hand-written except for the Sidechain Servers the wallet may reach: those come
// from the Chain Entries (`core/elements/chain-entry.json`), added as `host_permissions` and as the
// CSP's `connect-src`, so the wallet can talk to nothing else.
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { checkNoEval } from "./check-no-eval.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appBuild = path.resolve(root, "..", "app", "build");
const coreDist = path.resolve(root, "..", "core", "dist");
const dist = path.join(root, "dist");
const staging = path.join(dist, ".staging");
const TARGETS = ["chromium", "firefox"];
const CHAIN_ENTRIES = [path.resolve(root, "..", "core", "elements", "chain-entry.json")];

/** Every network's default Sidechain Server origin, across the bundled Chain Entries. */
async function sidechainServerOrigins() {
  const origins = new Set();
  for (const file of CHAIN_ENTRIES) {
    const entry = JSON.parse(await readFile(file, "utf8"));
    for (const network of Object.values(entry.networks)) origins.add(new URL(network.sidechainServer).origin);
  }
  return [...origins].sort();
}

/** The hand-written manifest plus access to the Sidechain Servers. */
async function manifestFor(target, servers) {
  const manifest = JSON.parse(await readFile(path.join(root, "manifests", `${target}.json`), "utf8"));
  manifest.host_permissions = servers.map((origin) => `${origin}/*`);
  const csp = manifest.content_security_policy;
  csp.extension_pages = `${csp.extension_pages}; connect-src 'self' ${servers.join(" ")}`;
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

await stat(path.join(appBuild, "index.html")).catch(() => {
  throw new Error(`No app build at ${appBuild}; run \`pnpm build\` from the repo root.`);
});
await stat(path.join(coreDist, "vault.wasm")).catch(() => {
  throw new Error(`No core build at ${coreDist}; run \`pnpm build\` from the repo root.`);
});
await rm(dist, { recursive: true, force: true });
await mkdir(staging, { recursive: true });

const common = { bundle: true, target: ["chrome111", "firefox128"], legalComments: "none", logLevel: "warning" };
// Background: an ES module (service worker on Chromium, background script on Firefox).
// Listeners must be registered synchronously at top level; no top-level await.
await esbuild.build({ ...common, entryPoints: [path.join(root, "src", "background.ts")], format: "esm", outfile: path.join(staging, "background.js") });
// Content script (isolated world) and injected Provider (page's main world): classic scripts.
await esbuild.build({ ...common, entryPoints: [path.join(root, "src", "content.ts")], format: "iife", outfile: path.join(staging, "content.js") });
await esbuild.build({ ...common, entryPoints: [path.join(root, "src", "inpage.ts")], format: "iife", outfile: path.join(staging, "inpage.js") });
await cp(appBuild, staging, { recursive: true });
// The core modules' WASM, staged once so both browsers ship the same bytes.
for (const file of (await readdir(coreDist)).filter((f) => f.endsWith(".wasm"))) {
  await cp(path.join(coreDist, file), path.join(staging, file));
}
await checkNoEval(staging);

const servers = await sidechainServerOrigins();
for (const target of TARGETS) {
  const out = path.join(dist, target);
  await cp(staging, out, { recursive: true });
  await writeFile(path.join(out, "manifest.json"), await manifestFor(target, servers));
  console.log(`extension: built ${path.relative(process.cwd(), out)}`);
}
await rm(staging, { recursive: true, force: true });
