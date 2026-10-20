// The shipped extension loads in each browser (unpacked in Brave, as a temporary add-on in Firefox)
// with no manifest errors or warnings, and its pages run under the manifest CSP without errors.
// Only onboarding pages are opened, so the shipped build never contacts the public explorer.
import assert from "node:assert/strict";
import { appendFile, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { BROWSERS, DIST, launchWallet } from "../harness.mjs";

for (const browserName of BROWSERS) describe(browserName, () => {
  let session;
  before(async () => {
    session = await launchWallet(browserName, { build: "shipped" });
  });
  after(() => session?.close());

  test("the extension loads with no manifest errors or warnings", async () => {
    const { manifestErrors, installWarnings } = await session.extensionErrors();
    assert.deepEqual(manifestErrors, []);
    assert.deepEqual(installWarnings, []);
  });

  test("the wallet's SvelteKit pages render under the manifest CSP with no runtime errors", async () => {
    const page = await session.openPage("index.html");
    await page.waitForSelector("[data-wallet-home]", { timeout: 10_000 });
    await page.close();
    assert.deepEqual((await session.extensionErrors()).runtimeErrors, []);
  });
});

// The two tests above pass vacuously if `extensionErrors()` sees nothing; this one shows it sees
// a manifest warning, a CSP violation on a wallet page and an uncaught error in the background.
for (const browserName of BROWSERS) {
  test(`${browserName}: extensionErrors() reports a broken build's manifest warning, CSP violation and background error`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ecx-e2e-broken-"));
    try {
      await cp(browserName === "firefox" ? DIST.firefox : DIST.chromium, dir, { recursive: true });
      const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
      await writeFile(path.join(dir, "manifest.json"), JSON.stringify({ ...manifest, ecx_bogus_key: 1 }));
      const html = await readFile(path.join(dir, "index.html"), "utf8");
      await writeFile(path.join(dir, "index.html"), html.replace("<head>", "<head><script>void 0</script>"));
      await appendFile(path.join(dir, "background.js"), '\nsetTimeout(() => { throw new Error("ecx-broken-background"); }, 0);\n');

      const session = await launchWallet(browserName, { extensionPath: dir });
      try {
        const page = await session.openPage("index.html");
        await page.waitForSelector("[data-wallet-home]", { timeout: 10_000 });
        await page.close();
        await new Promise((r) => setTimeout(r, 500));
        const { manifestErrors, installWarnings, runtimeErrors } = await session.extensionErrors();
        const warnings = JSON.stringify([manifestErrors, installWarnings]);
        const errors = JSON.stringify(runtimeErrors);
        assert.match(warnings, /ecx_bogus_key/);
        assert.match(errors, /Content.Security.Policy/i);
        assert.match(errors, /ecx-broken-background/);
      } finally {
        await session.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
