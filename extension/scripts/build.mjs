// Builds the extension for every browser from one source:
//   dist/chromium/  and  dist/firefox/
// Everything except manifest.json is built once into a staging dir and copied byte-for-byte into
// each target, so both browsers ship identical code (and, later, identical WASM).
//
// Inputs: the SvelteKit pages from ../app/build and the core modules' .wasm from ../core/dist (run
// those builds first; the root `pnpm build` does all three), and the plain-script entry points in
// src/ bundled with esbuild. Fails if any shipped script contains `eval(` or `new Function(`.
import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
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

for (const target of TARGETS) {
  const out = path.join(dist, target);
  await cp(staging, out, { recursive: true });
  await cp(path.join(root, "manifests", `${target}.json`), path.join(out, "manifest.json"));
  console.log(`extension: built ${path.relative(process.cwd(), out)}`);
}
await rm(staging, { recursive: true, force: true });
