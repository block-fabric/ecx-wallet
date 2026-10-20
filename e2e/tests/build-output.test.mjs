// What ships: both browser builds, checked as files (no browser needed).
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { DIST } from "../harness.mjs";

const EXPECTED_SCRIPT_SRC = ["'self'", "'wasm-unsafe-eval'"];

async function files(dir) {
  return (await readdir(dir, { recursive: true, withFileTypes: true }))
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)))
    .sort();
}

test("Chromium and Firefox builds ship identical files apart from manifest.json", async () => {
  const chromium = (await files(DIST.chromium)).filter((f) => f !== "manifest.json");
  const firefox = (await files(DIST.firefox)).filter((f) => f !== "manifest.json");
  assert.deepEqual(firefox, chromium);
  for (const f of chromium) {
    const [a, b] = await Promise.all([readFile(path.join(DIST.chromium, f)), readFile(path.join(DIST.firefox, f))]);
    assert.ok(a.equals(b), `${f} differs between builds`);
  }
});

for (const [target, dir] of Object.entries(DIST)) {
  test(`${target}: manifest CSP allows 'wasm-unsafe-eval' and nothing looser`, async () => {
    const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
    assert.equal(manifest.manifest_version, 3);
    const directives = Object.fromEntries(
      manifest.content_security_policy.extension_pages
        .split(";")
        .map((d) => d.trim().split(/\s+/))
        .filter((d) => d[0])
        .map(([name, ...values]) => [name, values]),
    );
    assert.deepEqual(directives["script-src"], EXPECTED_SCRIPT_SRC);
    assert.deepEqual(directives["object-src"], ["'none'"]);
    assert.equal(directives["default-src"], undefined, "default-src would widen script-src fallbacks");
  });

  test(`${target}: built pages contain no inline scripts or inline event handlers`, async () => {
    for (const f of (await files(dir)).filter((f) => f.endsWith(".html"))) {
      const html = await readFile(path.join(dir, f), "utf8");
      for (const [, attrs] of html.matchAll(/<script\b([^>]*)>/g)) {
        assert.match(attrs, /\bsrc=/, `${f} has an inline <script>`);
      }
      assert.doesNotMatch(html, /\son[a-z]+\s*=/i, `${f} has an inline event handler`);
    }
  });
}
