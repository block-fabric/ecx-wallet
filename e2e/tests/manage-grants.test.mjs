// Seam 1: a user sees and revokes Grants; a Sidechain App disconnects.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { BROWSERS, launchWallet, openTestApp, openWalletPage, serveTestApp, setUpWallet } from "../harness.mjs";

for (const browserName of BROWSERS) describe(browserName, () => {

let session;
let app;
before(async () => {
  [session, app] = await Promise.all([launchWallet(browserName), serveTestApp()]);
  // Unlocked, so a Granted getAddresses actually answers.
  await setUpWallet(session);
});
after(async () => {
  await session?.close();
  await app?.close();
});

/** Opens the test app on `host` and connects it with `scope`, approving the prompt. */
async function connected(host, scope) {
  const page = await openTestApp(session, app, host);
  const connecting = page.evaluate((scope) => window.testApp.request("connect", scope), scope);
  await (await session.waitForApprovalWindow()).click("[data-approve]");
  assert.ok((await connecting).result, "connect was approved");
  return page;
}

const getAddresses = (page) => page.evaluate(() => window.testApp.request("getAddresses", { slot: 24 }));

test("disconnect removes the calling origin's Grant only", async () => {
  const scope = { slots: [24], methods: ["getAddresses"] };
  const leaving = await connected("leaving.localhost", scope);
  const staying = await connected("staying.localhost", scope);

  assert.deepEqual(await leaving.evaluate(() => window.testApp.request("disconnect")), { result: null });
  assert.equal((await getAddresses(leaving)).error?.code, 4100);
  assert.ok((await getAddresses(staying)).result, "the other origin still gets its addresses");

  // Disconnecting again, with no Grant left, is harmless.
  assert.deepEqual(await leaving.evaluate(() => window.testApp.request("disconnect")), { result: null });
  await Promise.all([leaving.close(), staying.close()]);
});

/** The Grants screen as a user reads it: one entry per origin. */
async function readGrants() {
  const page = await openWalletPage(session, "#/grants");
  const grants = await page.evaluate(() =>
    [...document.querySelectorAll("[data-grant]")].map((g) => ({
      origin: g.querySelector("[data-origin]")?.textContent.trim(),
      slots: [...g.querySelectorAll("[data-slot]")].map((e) => e.textContent.trim()),
      methods: [...g.querySelectorAll("[data-method]")].map((e) => e.textContent.trim()),
      blindSigning: g.querySelector("[data-blind-signing]")?.textContent.trim(),
    })),
  );
  return { page, grants };
}

test("the Grants screen lists every Grant by origin with its scope and Blind Signing opt-in", async () => {
  const listedA = await connected("listed-a.localhost", { slots: [24], methods: ["getAddresses"] });
  const listedB = await connected("listed-b.localhost", { slots: [24], methods: ["getAddresses", "signTransaction"] });

  const { page, grants } = await readGrants();
  const listed = grants.filter((g) => g.origin.includes("listed-"));
  assert.deepEqual(listed, [
    { origin: app.origin("listed-a.localhost"), slots: ["24"], methods: ["getAddresses"], blindSigning: "Off" },
    { origin: app.origin("listed-b.localhost"), slots: ["24"], methods: ["getAddresses", "signTransaction"], blindSigning: "Off" },
  ]);
  await Promise.all([page.close(), listedA.close(), listedB.close()]);
});

test("revoking a Grant on the Grants screen makes that origin's next request fail with 4100 until it connects again", async () => {
  const scope = { slots: [24], methods: ["getAddresses"] };
  const revoked = await connected("revoked.localhost", scope);
  const kept = await connected("kept.localhost", scope);
  const revokedOrigin = app.origin("revoked.localhost");

  const { page } = await readGrants();
  await page.click(`[data-grant][data-grant-origin="${revokedOrigin}"] [data-revoke]`);
  await page.waitForFunction(
    (origin) => !document.querySelector(`[data-grant][data-grant-origin="${origin}"]`),
    {},
    revokedOrigin,
  );
  const origins = (await readGrants().then(async ({ page, grants }) => (await page.close(), grants))).map((g) => g.origin);
  assert.ok(!origins.includes(revokedOrigin), "the revoked Grant is gone from the list");
  assert.ok(origins.includes(app.origin("kept.localhost")), "other Grants are untouched");

  assert.equal((await getAddresses(revoked)).error?.code, 4100);
  assert.ok((await getAddresses(kept)).result, "the kept origin still gets its addresses");

  // Connecting again prompts again, and restores access.
  const reconnecting = revoked.evaluate((scope) => window.testApp.request("connect", scope), scope);
  await (await session.waitForApprovalWindow()).click("[data-approve]");
  assert.deepEqual(await reconnecting, { result: scope });
  assert.ok((await getAddresses(revoked)).result, "reconnecting restores access");
  await Promise.all([page.close(), revoked.close(), kept.close()]);
});

// Brave only: Firefox has no API to read an extension's error console.
test("none of the above raised extension runtime errors", async () => {
  assert.deepEqual((await session.extensionErrors()).runtimeErrors, []);
});

});
