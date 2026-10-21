// Seam 1: the Slot 24 receive address, in the home page's Receive sheet and through the Provider.
//
// The wallet imports "abandon … about" with no passphrase. Its Slot 24 Starter is a BitWindow
// vector and the address below was computed from that Starter independently (see
// core/elements/tests/elements.rs), so seeing it proves the address came from the Slot 24 Starter.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { BROWSERS, launchWallet, openTestApp, serveTestApp, setUpWallet, WALLET_PASSWORD } from "../harness.mjs";

const SLOT_24_ADDRESS = "elements1qew44aehkjstjm56ng2rjrz57vwxh5g9su6dlpm";
/** BIP84's own vector for "abandon … about", m/84'/0'/0'/0/0 (bip-0084.mediawiki). */
const L1_ADDRESS = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";

/** Opens home's Receive sheet, which lists every chain's address. */
async function openReceive(session) {
  const page = await session.openPage("index.html#/");
  await page.waitForSelector("[data-receive-action]", { timeout: 10_000 });
  await page.click("[data-receive-action]");
  await page.waitForSelector("[data-receive-sheet]");
  return page;
}

async function typeInto(page, selector, text) {
  await page.$eval(selector, (e) => (e.value = ""));
  await page.type(selector, text);
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
    await setUpWallet(session); // ABANDON, no passphrase
  });
  after(async () => {
    await session?.close();
    await app?.close();
  });

  test("Receive shows the Slot 24 receive address in elements… encoding", async () => {
    const page = await openReceive(session);
    const card = '[data-receive-sheet] [data-account="24"]';
    await page.waitForSelector(`${card} [data-receive-address]`, { timeout: 20_000 });
    assert.equal(await page.$eval(`${card} [data-receive-address]`, (e) => e.textContent.trim()), SLOT_24_ADDRESS);
    assert.match(await page.$eval(`${card} [data-account-chain]`, (e) => e.textContent), /ecash:betanet-s24/);
    await page.close();
  });

  test("Receive shows the main chain's receive address, BIP84's m/84'/0'/0'/0/0, above the Slots", async () => {
    const page = await openReceive(session);
    const card = '[data-receive-sheet] [data-account="l1"]';
    await page.waitForSelector(`${card} [data-receive-address]`, { timeout: 20_000 });
    assert.equal(await page.$eval(`${card} [data-receive-address]`, (e) => e.textContent.trim()), L1_ADDRESS);
    assert.match(await page.$eval(`${card} [data-account-chain]`, (e) => e.textContent), /^ecash:betanet$/);
    await page.waitForSelector('[data-receive-sheet] [data-account="24"]', { timeout: 20_000 });
    const order = await page.$$eval("[data-receive-sheet] [data-account]", (cards) => cards.map((c) => c.getAttribute("data-account")));
    assert.deepEqual(order, ["l1", "24"]);
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
    const home = await session.openPage("index.html#/");
    await home.waitForSelector("[data-lock]", { timeout: 10_000 });
    await home.click("[data-lock]");
    await home.waitForSelector('[data-vault-state="locked"]');
    const locked = await page.evaluate(() => window.testApp.request("getAddresses", { slot: 24 }));
    assert.equal(locked.error?.code, 4100);
    assert.match(locked.error?.message, /locked/i);

    await typeInto(home, "[data-password]", WALLET_PASSWORD);
    await home.click("[data-unlock]");
    await home.waitForSelector('[data-vault-state="unlocked"]');
    const unlocked = await page.evaluate(() => window.testApp.request("getAddresses", { slot: 24 }));
    assert.deepEqual(unlocked, { result: [{ chain: "ecash:betanet-s24", address: SLOT_24_ADDRESS }] });
    await Promise.all([page.close(), home.close()]);
  });

  test("none of the above raised extension runtime errors", async () => {
    assert.deepEqual((await session.extensionErrors()).runtimeErrors, []);
  });
});
