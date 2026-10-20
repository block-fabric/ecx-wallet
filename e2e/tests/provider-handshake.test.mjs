// Seam 1: a Sidechain App on a web page finds the wallet and connects to it.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { launchBrave, openTestApp, serveTestApp } from "../harness.mjs";

let session;
let app;
before(async () => {
  [session, app] = await Promise.all([launchBrave(), serveTestApp()]);
});
after(async () => {
  await session?.close();
  await app?.close();
});

test("a Sidechain App discovers the Provider through announce/request events, not a window global", async () => {
  const page = await openTestApp(session, app);
  const wallets = await page.evaluate(() => window.testApp.discover());
  assert.equal(wallets.length, 1);
  assert.equal(wallets[0].name, "ECX Wallet");
  assert.equal(wallets[0].rdns, "cash.ecx.wallet");
  assert.equal(await page.evaluate(() => window.testApp.providerIsOnWindow()), false);
  await page.close();
});

/** What the approval window shows, read the way a user would see it. */
function readApproval(approval) {
  return approval.evaluate(() => ({
    origin: document.querySelector("[data-origin]")?.textContent.trim(),
    slots: [...document.querySelectorAll("[data-slot]")].map((e) => e.textContent.trim()),
    methods: [...document.querySelectorAll("[data-method]")].map((e) => e.textContent.trim()),
  }));
}

test("connect shows the browser-reported origin and the requested scope; approving grants it once per origin", async () => {
  const host = "approve.localhost";
  const page = await openTestApp(session, app, host);
  const scope = { slots: [24], methods: ["getAddresses", "signTransaction"] };
  // The page also claims another origin in its params; only the browser's view may count.
  const connecting = page.evaluate(
    (scope) => window.testApp.request("connect", { ...scope, origin: "https://official.example" }),
    scope,
  );

  const approval = await session.waitForApprovalWindow();
  assert.deepEqual(await readApproval(approval), {
    origin: app.origin(host),
    slots: ["24"],
    methods: ["getAddresses", "signTransaction"],
  });
  await approval.click("[data-approve]");
  assert.deepEqual(await connecting, { result: scope });

  // Same origin, same scope: answered from the stored Grant, no second prompt.
  const again = await page.evaluate((scope) => window.testApp.request("connect", scope), scope);
  assert.deepEqual(again, { result: scope });
  assert.equal((await session.approvalWindows()).length, 0);

  // A fresh page load from the same origin is covered by the same Grant.
  const reloaded = await openTestApp(session, app, host);
  const narrower = await reloaded.evaluate(() =>
    window.testApp.request("connect", { slots: [24], methods: ["getAddresses"] }),
  );
  assert.deepEqual(narrower, { result: scope });
  assert.equal((await session.approvalWindows()).length, 0);
  await Promise.all([page.close(), reloaded.close()]);
});

test("rejecting the approval returns 4001 and stores no Grant", async () => {
  const page = await openTestApp(session, app, "reject.localhost");
  const scope = { slots: [24], methods: ["getAddresses"] };
  const connecting = page.evaluate((scope) => window.testApp.request("connect", scope), scope);
  await (await session.waitForApprovalWindow()).click("[data-reject]");
  assert.equal((await connecting).error?.code, 4001);

  // Nothing was granted: the next connect prompts again, and closing that window also rejects.
  const retry = page.evaluate((scope) => window.testApp.request("connect", scope), scope);
  await (await session.waitForApprovalWindow()).close();
  assert.equal((await retry).error?.code, 4001);
  assert.equal((await page.evaluate(() => window.testApp.request("getAddresses", { slot: 24 }))).error?.code, 4100);
  await page.close();
});

test("an unsupported method returns 4200", async () => {
  const page = await openTestApp(session, app, "unsupported.localhost");
  assert.equal((await page.evaluate(() => window.testApp.request("eth_accounts"))).error?.code, 4200);
  await page.close();
});

test("a method outside the origin's Grant returns 4100, and Grants never carry over to another origin", async () => {
  const granted = await openTestApp(session, app, "granted.localhost");
  const connecting = granted.evaluate(() =>
    window.testApp.request("connect", { slots: [24], methods: ["getAddresses"] }),
  );
  await (await session.waitForApprovalWindow()).click("[data-approve]");
  assert.ok((await connecting).result);
  assert.equal((await granted.evaluate(() => window.testApp.request("signTransaction", {}))).error?.code, 4100);

  // Another origin gets nothing from that Grant, whatever it claims about itself.
  const stranger = await openTestApp(session, app, "stranger.localhost");
  const claimed = await stranger.evaluate(
    (origin) => window.testApp.request("getAddresses", { slot: 24, origin }),
    app.origin("granted.localhost"),
  );
  assert.equal(claimed.error?.code, 4100);
  await Promise.all([granted.close(), stranger.close()]);
});

test("none of the above raised extension runtime errors (CSP violations, uncaught exceptions)", async () => {
  assert.deepEqual((await session.extensionErrors()).runtimeErrors, []);
});
