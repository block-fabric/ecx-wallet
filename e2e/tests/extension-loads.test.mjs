import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { launchBrave } from "../harness.mjs";

let session;
before(async () => {
  session = await launchBrave();
});
after(() => session?.close());

test("the Chromium build loads unpacked in Brave with no manifest errors or warnings", async () => {
  const { manifestErrors, installWarnings } = await session.extensionErrors();
  assert.deepEqual(manifestErrors, []);
  assert.deepEqual(installWarnings, []);
});

test("the wallet's SvelteKit pages render under the manifest CSP with no runtime errors", async () => {
  const page = await session.browser.newPage();
  const violations = [];
  page.on("console", (message) => {
    if (message.type() === "error") violations.push(message.text());
  });
  await page.goto(session.extensionUrl("index.html"));
  await page.waitForSelector("[data-wallet-home]", { timeout: 10_000 });
  await page.close();
  assert.deepEqual(violations, []);
  const { runtimeErrors } = await session.extensionErrors();
  assert.deepEqual(runtimeErrors, []);
});
