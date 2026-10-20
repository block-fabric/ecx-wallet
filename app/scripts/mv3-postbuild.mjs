// MV3 fix for SvelteKit's static output: extension pages may not run inline scripts, and the
// manifest CSP must not be loosened to allow them. SvelteKit emits its bootstrap as an inline
// <script>; move each one into a file under the app dir and reference it by src, in place.
//
// It stays a classic script (not type="module") because the bootstrap reads
// `document.currentScript.parentElement` to find its mount point; dynamic import() still works.
//
//   node scripts/mv3-postbuild.mjs <build dir>
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import config from "../svelte.config.js";

const buildDir = path.resolve(process.argv[2] ?? "build");
const appDir = config.kit.appDir;
const INLINE_SCRIPT = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g;

for (const file of (await readdir(buildDir, { recursive: true })).filter((f) => f.endsWith(".html"))) {
  const htmlPath = path.join(buildDir, file);
  const html = await readFile(htmlPath, "utf8");
  const writes = [];
  const rewritten = html.replace(INLINE_SCRIPT, (_match, attrs, body) => {
    const name = `bootstrap.${createHash("sha256").update(body).digest("hex").slice(0, 12)}.js`;
    writes.push(writeFile(path.join(buildDir, appDir, name), body.trim() + "\n"));
    return `<script${attrs} src="/${appDir}/${name}"></script>`;
  });
  await Promise.all(writes);
  if (INLINE_SCRIPT.test(rewritten)) throw new Error(`${file}: inline script left after rewrite`);
  await writeFile(htmlPath, rewritten);
  console.log(`mv3-postbuild: ${file}: moved ${writes.length} inline script(s) to files`);
}
