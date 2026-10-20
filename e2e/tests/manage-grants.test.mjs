// Seam 1: a user sees and revokes Grants; a Sidechain App disconnects.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { BROWSERS, launchWallet, openTestApp, openWalletPage, serveTestApp } from "../harness.mjs";

for (const browserName of BROWSERS) describe(browserName, () => {

let session;
let app;
before(async () => {
  [session, app] = await Promise.all([launchWallet(browserName), serveTestApp()]);
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
  assert.notEqual((await getAddresses(staying)).error?.code, 4100);

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

});
