// Seam 1: the Slot 24 receive address, in the home page's Receive sheet and through the Provider.
//
// The wallet imports "abandon … about" with no passphrase. Its Slot 24 Starter is a BitWindow
// vector and the address below was computed from that Starter independently (see
// core/elements/tests/elements.rs), so seeing it proves the address came from the Slot 24 Starter.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { BROWSERS, launchWallet, openTestApp, openWalletPage, serveTestApp, setUpWallet, WALLET_PASSWORD } from "../harness.mjs";

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

  /** Unfolds `account`'s row in the Receive sheet; returns what it shows. */
  async function unfold(page, account) {
    const row = `[data-receive-sheet] [data-account="${account}"]`;
    await page.waitForSelector(`${row} [data-qr-toggle]`, { timeout: 20_000 });
    await page.click(`${row} [data-qr-toggle]`);
    await page.waitForSelector(`${row} [data-qr]`);
    return page.$eval(row, (e) => ({
      short: e.querySelector("[data-short-address]").textContent.trim(),
      address: e.querySelector("[data-receive-address]").textContent.trim(),
      qr: e.querySelector("[data-qr]").getAttribute("data-qr"),
      chain: e.querySelector("[data-account-chain]").textContent.trim(),
      unfolded: [...document.querySelectorAll("[data-receive-sheet] [data-qr]")].length,
    }));
  }

  test("Receive shows the Slot 24 receive address in elements… encoding, and its QR code", async () => {
    const page = await openReceive(session);
    const shown = await unfold(page, "24");
    assert.equal(shown.address, SLOT_24_ADDRESS);
    assert.equal(shown.qr, SLOT_24_ADDRESS, "the QR code is of the address shown (tests/qr.test scans one back)");
    assert.equal(shown.short, "elements1qew…9su6dlpm", "the row shows its two ends");
    assert.equal(shown.chain, "ecash:betanet-s24");
    await page.close();
  });

  test("Receive shows the main chain's receive address, BIP84's m/84'/0'/0'/0/0, above the Slots; one QR code at a time", async () => {
    const page = await openReceive(session);
    await unfold(page, "24");
    const shown = await unfold(page, "l1");
    assert.equal(shown.address, L1_ADDRESS);
    assert.equal(shown.qr, L1_ADDRESS);
    assert.equal(shown.chain, "ecash:betanet");
    assert.equal(shown.unfolded, 1, "unfolding one folds the other");
    const order = await page.$$eval("[data-receive-sheet] [data-account]", (rows) => rows.map((r) => r.getAttribute("data-account")));
    assert.deepEqual(order, ["l1", "24"]);
    await page.close();
  });

  test("a chain's own screen opens Receive on its QR code", async () => {
    const page = await openWalletPage(session, "#/chain/24");
    await page.click("[data-receive-action]");
    await page.waitForSelector('[data-receive-sheet] [data-account="24"] [data-qr]', { timeout: 20_000 });
    assert.deepEqual(await page.$$eval("[data-receive-sheet] [data-account]", (rows) => rows.map((r) => r.getAttribute("data-account"))), ["24"]);
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
