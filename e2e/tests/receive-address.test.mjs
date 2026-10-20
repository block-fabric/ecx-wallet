// Seam 1: the Slot 24 receive address, on the account screen and through the Provider.
//
// The wallet imports "abandon … about" with no passphrase. Its Slot 24 Starter is a BitWindow
// vector and the address below was computed from that Starter independently (see
// core/elements/tests/elements.rs), so seeing it proves the address came from the Slot 24 Starter.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { BROWSERS, launchWallet, openTestApp, serveTestApp } from "../harness.mjs";

const ABANDON = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const PASSWORD = "correct horse battery";
const SLOT_24_ADDRESS = "elements1qew44aehkjstjm56ng2rjrz57vwxh5g9su6dlpm";

async function openHome(session) {
  const page = await session.openPage("index.html#/");
  await page.waitForSelector("[data-wallet-ready]", { timeout: 10_000 });
  return page;
}

async function typeInto(page, selector, text) {
  await page.$eval(selector, (e) => (e.value = ""));
  await page.type(selector, text);
}

async function importAbandon(session) {
  const page = await session.openPage("index.html#/import");
  await page.waitForSelector("[data-wallet-ready]", { timeout: 10_000 });
  await typeInto(page, "[data-import-phrase]", ABANDON);
  await typeInto(page, "[data-new-password]", PASSWORD);
  await typeInto(page, "[data-repeat-password]", PASSWORD);
  await page.click("[data-submit]");
  await page.waitForSelector('[data-vault-state="unlocked"]');
  await page.close();
}

/** Connects `host`'s test app with `scope`, approving the prompt. */
async function connect(session, app, host, scope) {
  const page = await openTestApp(session, app, host);
  const connecting = page.evaluate((scope) => window.testApp.request("connect", scope), scope);
  await (await session.waitForApprovalWindow()).click("[data-approve]");
  assert.ok((await connecting).result, "connected");
  return page;
}

for (const browserName of BROWSERS) describe(browserName, () => {
  let session;
  let app;
  before(async () => {
    [session, app] = await Promise.all([launchWallet(browserName), serveTestApp()]);
    await importAbandon(session);
  });
  after(async () => {
    await session?.close();
    await app?.close();
  });

  test("the account screen shows the Slot 24 receive address in elements… encoding", async () => {
    const page = await openHome(session);
    await page.waitForSelector("[data-receive-address]", { timeout: 20_000 });
    assert.equal(await page.$eval("[data-receive-address]", (e) => e.textContent.trim()), SLOT_24_ADDRESS);
    assert.match(await page.$eval("[data-account-chain]", (e) => e.textContent), /ecash:betanet-s24/);
    await page.close();
  });

  test("getAddresses returns the Slot 24 address to an origin whose Grant covers Slot 24", async () => {
    const page = await connect(session, app, "addresses.localhost", { slots: [24], methods: ["getAddresses"] });
    const answer = await page.evaluate(() => window.testApp.request("getAddresses", { slot: 24 }));
    assert.deepEqual(answer, { result: [{ chain: "ecash:betanet-s24", address: SLOT_24_ADDRESS }] });
    await page.close();
  });

  test("getAddresses fails with 4100 for an origin whose Grant doesn't cover Slot 24", async () => {
    const page = await connect(session, app, "other-slot.localhost", { slots: [9], methods: ["getAddresses"] });
    const answer = await page.evaluate(() => window.testApp.request("getAddresses", { slot: 24 }));
    assert.equal(answer.error?.code, 4100);
    await page.close();
  });

  test("getAddresses fails with 4100 while the wallet is locked, and works again after unlock", async () => {
    const page = await connect(session, app, "locked.localhost", { slots: [24], methods: ["getAddresses"] });
    const home = await openHome(session);
    await home.click("[data-lock]");
    await home.waitForSelector('[data-vault-state="locked"]');
    const locked = await page.evaluate(() => window.testApp.request("getAddresses", { slot: 24 }));
    assert.equal(locked.error?.code, 4100);
    assert.match(locked.error?.message, /locked/i);

    await typeInto(home, "[data-password]", PASSWORD);
    await home.click("[data-unlock]");
    await home.waitForSelector('[data-vault-state="unlocked"]');
    const unlocked = await page.evaluate(() => window.testApp.request("getAddresses", { slot: 24 }));
    assert.deepEqual(unlocked, { result: [{ chain: "ecash:betanet-s24", address: SLOT_24_ADDRESS }] });
    await Promise.all([page.close(), home.close()]);
  });

  test("none of the above raised extension runtime errors", { skip: browserName !== "brave" }, async () => {
    assert.deepEqual((await session.extensionErrors()).runtimeErrors, []);
  });
});
