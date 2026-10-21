// Seam 1, pull path: the e2e build's wallet reads Slot 24's and eCash's balances from their
// Sidechain Servers, stub Esplora servers listening where that build's Chain Entries name betanet's
// servers (the shipped build's are the Elements explorer and esplora.beta.ecash.ninja;
// build-output.test checks that's the only difference). The stubs send no CORS headers, like the
// Elements explorer: the wallet gets through on its host permissions.
//
// The wallet imports "abandon … about". Its Slot 24 receive and change addresses are fixed
// vectors (core/elements/tests/elements.rs), its eCash ones BIP84's (core/l1/tests/l1.rs). The Standard Sidechain API's Send is tested in node,
// in sidechain-servers.test.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { BROWSERS, launchWallet, openWalletPage, relock, serveEsplora, serveL1Esplora, setUpWallet, WALLET_PASSWORD } from "../harness.mjs";

const GENESIS = "a7754ce0debc40baddbd8c47e79d19209685f22c63edaaf8b69cf54116374d7f";
const RECEIVE_0 = "elements1qew44aehkjstjm56ng2rjrz57vwxh5g9su6dlpm";
const RECEIVE_1 = "elements1qnx6kczxpu35ypahwhqddx2pn6q0nuyaap97ygn";
const CHANGE_0 = "elements1q2n6usykz5ycrnfpup3hx0qa0manae07jgvvmuc";
const POLICY_ASSET = "5836dcc06130dcf6a65b6ac493813fd65559955283e44cc3f07966294eccb2c8";
const OTHER_ASSET = "1111111111111111111111111111111111111111111111111111111111111111";
const FOREIGN_ADDRESS = "elements1qepkhlwlq2qjggg89d5quqx8z59vz9mr2h6j4pc";

/** What the stub Esplora server holds for the wallet's addresses (read on every request). */
const ESPLORA = {
  identityBlock: { height: 0, hash: GENESIS },
  utxos: {
    [RECEIVE_0]: [
      { txid: "a0".repeat(32), vout: 0, value: 150000, asset: POLICY_ASSET, confirmed: true },
      // Unconfirmed: shown apart, not in the balance.
      { txid: "a1".repeat(32), vout: 0, value: 5000, asset: POLICY_ASSET, confirmed: false },
    ],
    [RECEIVE_1]: [{ txid: "a2".repeat(32), vout: 1, value: 7, asset: OTHER_ASSET, confirmed: true }],
    // A change address: counted.
    [CHANGE_0]: [{ txid: "a3".repeat(32), vout: 1, value: 29000, asset: POLICY_ASSET, confirmed: true }],
  },
};

/** eCash betanet's fork block: the identity block in its Chain Entry. */
const L1_FORK_BLOCK = { height: 967680, hash: "00000000000000030101ba5cfea54b22becc79f95dc6040beb76e01dd9d04042" };
/** Bitcoin's block at the same height: a Bitcoin server's answer. */
const BITCOIN_AT_FORK = "0000000000000000000161354016172f2a377610d52dd46d0f68a919333458cd";
const L1_RECEIVE_0 = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
const L1_CHANGE_0 = "bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el";

/** What the stub eCash Esplora server holds: outputs as Bitcoin's Esplora shows them, with no asset. */
const L1_ESPLORA = {
  identityBlock: L1_FORK_BLOCK,
  utxos: {
    [L1_RECEIVE_0]: [
      { txid: "b0".repeat(32), vout: 0, value: 100000, confirmed: true },
      { txid: "b1".repeat(32), vout: 0, value: 900, confirmed: false },
    ],
    [L1_CHANGE_0]: [{ txid: "b2".repeat(32), vout: 1, value: 2500, confirmed: true }],
  },
};

/** One chain's section on home: its fresh reported balances (or why there are none), as a user reads them. */
async function readHome(session, account = "24") {
  const page = await session.openPage("index.html#/");
  await page.waitForSelector("[data-wallet-ready]", { timeout: 10_000 });
  const card = `[data-account="${account}"]`;
  await page.waitForSelector(`${card}:not([data-refreshing]) :is([data-balance], [data-no-balance], [data-balance-error])`, { timeout: 20_000 });
  const shown = await page.evaluate((card) => {
    const text = (e) => e?.textContent.replace(/\s+/g, " ").trim();
    const within = document.querySelector(card);
    return {
      server: within.getAttribute("data-server") ?? undefined,
      error: text(within.querySelector("[data-balance-error]")),
      balances: [...within.querySelectorAll("[data-balance]")].map((e) => ({ asset: e.getAttribute("data-asset"), text: text(e) })),
      unconfirmed: [...within.querySelectorAll("[data-unconfirmed]")].map((e) => ({ asset: e.getAttribute("data-asset"), text: text(e) })),
    };
  }, card);
  // Send asks which chain first; a chain that can't send yet is greyed out there.
  await page.click("[data-send-action]");
  await page.waitForSelector("[data-send-sheet]");
  shown.send = await page.$eval(`[data-send-link="${account}"]`, (e) => !e.hasAttribute("data-disabled"));
  await page.close();
  return shown;
}

/** The home page's total and every chain's section, once each chain's fresh report is in. */
async function readTotal(page) {
  await page.waitForSelector("[data-total-ready]", { timeout: 20_000 });
  return page.evaluate(() => {
    const text = (e) => e?.textContent.replace(/\s+/g, " ").trim();
    return {
      label: text(document.querySelector("[data-total]").previousElementSibling),
      total: text(document.querySelector("[data-total]")),
      unconfirmed: text(document.querySelector("[data-total-unconfirmed]")),
      unavailable: text(document.querySelector("[data-unavailable]")),
      network: text(document.querySelector("[data-network]")),
      chains: [...document.querySelectorAll("[data-account]")].map((e) => ({
        name: text(e.querySelector("[data-chain-link] strong")),
        subtotal: text(e.querySelector("[data-subtotal]")),
        assets: [...e.querySelectorAll("li[data-asset]")].map((li) => [text(li.querySelector("strong")), text(li.querySelector("[data-balance]"))]),
      })),
    };
  });
}

for (const browserName of BROWSERS) describe(browserName, () => {
  let session;
  let stub;
  let l1Stub;
  before(async () => {
    [session, stub, l1Stub] = await Promise.all([launchWallet(browserName), serveEsplora(ESPLORA), serveL1Esplora(L1_ESPLORA)]);
    await setUpWallet(session); // ABANDON, no passphrase
  });
  after(async () => {
    await session?.close();
    await stub?.close();
    await l1Stub?.close();
  });

  test("the home page shows each asset's confirmed balance over the receive and change addresses, and what's unconfirmed apart, labelled as reported by the server", async () => {
    const shown = await readHome(session);
    assert.equal(shown.error, undefined);
    assert.equal(shown.server, stub.url);
    assert.deepEqual(shown.balances.map((b) => b.asset), [POLICY_ASSET, OTHER_ASSET]);
    assert.equal(shown.balances[0].text, "0.00179 ECX", "150 000 received + 29 000 change, not the unconfirmed 5 000");
    assert.equal(shown.balances[1].text, "7", "an asset the Chain Entry doesn't name, in base units");
    assert.deepEqual(shown.unconfirmed.map((u) => u.asset), [POLICY_ASSET], "no line for an asset with nothing unconfirmed");
    assert.equal(shown.unconfirmed[0].text, "+0.00005 ECX unconfirmed");

    const requests = stub.requests();
    assert.equal(requests[0], "/block-height/0", "the server's chain is checked first");
    for (const address of [RECEIVE_0, RECEIVE_1, CHANGE_0]) assert.ok(requests.includes(`/address/${address}/utxo`), `asked for ${address}`);
  });

  test("a server on another chain gives that Slot a hard error and no balance", async () => {
    ESPLORA.identityBlock = { height: 0, hash: "00".repeat(32) };
    await relock(session); // the wallet checks a server's chain once per session
    try {
      const shown = await readHome(session);
      assert.deepEqual(shown.balances, []);
      assert.match(shown.error, /another chain/);
    } finally {
      ESPLORA.identityBlock = { height: 0, hash: GENESIS };
    }
  });

  test("the eCash card shows the confirmed sats of the L1 receive and change addresses, and the unconfirmed ones apart, labelled as reported by its server", async () => {
    const shown = await readHome(session, "l1");
    assert.equal(shown.error, undefined);
    assert.equal(shown.server, l1Stub.url);
    assert.deepEqual(shown.balances.map((b) => b.asset), [""]);
    assert.equal(shown.balances[0].text, "0.001025 ECX", "100 000 received + 2 500 change, not the unconfirmed 900");
    assert.deepEqual(shown.unconfirmed, [{ asset: "", text: "+0.000009 ECX unconfirmed" }]);
    assert.equal(shown.send, false, "no Send on L1 yet");

    const requests = l1Stub.requests();
    assert.equal(requests[0], "/block-height/967680", "the fork block is checked first");
    for (const address of [L1_RECEIVE_0, L1_CHANGE_0]) assert.ok(requests.includes(`/address/${address}/utxo`), `asked for ${address}`);
  });

  test("an eCash server on Bitcoin's chain is a hard error for the eCash card only", async () => {
    L1_ESPLORA.identityBlock = { ...L1_FORK_BLOCK, hash: BITCOIN_AT_FORK };
    await relock(session);
    try {
      const shown = await readHome(session, "l1");
      assert.deepEqual(shown.balances, []);
      assert.match(shown.error, new RegExp(`another chain: its block 967680 is ${BITCOIN_AT_FORK}`));
      assert.equal((await readHome(session, "24")).error, undefined, "Slot 24 still reads its balance");
    } finally {
      L1_ESPLORA.identityBlock = L1_FORK_BLOCK;
    }
  });

  test("an eCash server that hasn't reached the fork block says so", async () => {
    L1_ESPLORA.identityBlock = { height: 0, hash: "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f" };
    await relock(session);
    try {
      const shown = await readHome(session, "l1");
      assert.deepEqual(shown.balances, []);
      assert.match(shown.error, /hasn't synced to block 967680/);
    } finally {
      L1_ESPLORA.identityBlock = L1_FORK_BLOCK;
    }
  });

  test("a server's chain is checked once per session, and again after a lock", async () => {
    await relock(session);
    const checks = () => l1Stub.requests().filter((r) => r === "/block-height/967680").length;
    const before = checks();
    await readHome(session, "l1");
    await readHome(session, "l1");
    assert.equal(checks(), before, "relock's unlock already checked it");
    await relock(session);
    assert.equal(checks(), before + 1, "checked again after the lock");
  });

  test("the home page shows this session's last balance at once, says it's refreshing, then shows the new one", async () => {
    await readHome(session, "l1"); // 102 500 sats and 900 unconfirmed, now remembered
    L1_ESPLORA.delayMs = 1500;
    L1_ESPLORA.utxos[L1_CHANGE_0][0].value = 7500;
    L1_ESPLORA.utxos[L1_RECEIVE_0][1].value = 1200;
    try {
      const page = await session.openPage("index.html#/");
      const card = '[data-account="l1"]';
      await page.waitForSelector(`${card}[data-refreshing] [data-balance]`, { timeout: 10_000 });
      const stale = await page.$eval(card, (e) => ({
        balance: e.querySelector("[data-balance]").textContent.replace(/\s+/g, " ").trim(),
        unconfirmed: e.querySelector("[data-unconfirmed]")?.textContent.replace(/\s+/g, " ").trim(),
        readAt: e.querySelector("[data-read-at]").textContent.replace(/\s+/g, " ").trim(),
      }));
      assert.equal(stale.balance, "0.001025 ECX");
      assert.equal(stale.unconfirmed, "+0.000009 ECX unconfirmed");
      assert.match(stale.readAt, /^Last read at .+; refreshing…$/);
      await page.waitForSelector(`${card}:not([data-refreshing]) [data-balance]`, { timeout: 20_000 });
      assert.equal(await page.$eval(`${card} [data-balance]`, (e) => e.textContent.replace(/\s+/g, " ").trim()), "0.001075 ECX");
      assert.equal(await page.$eval(`${card} [data-unconfirmed]`, (e) => e.textContent.replace(/\s+/g, " ").trim()), "+0.000012 ECX unconfirmed");
      assert.equal(await page.$(`${card} [data-read-at]`), null);
      await page.close();
    } finally {
      L1_ESPLORA.delayMs = 0;
      L1_ESPLORA.utxos[L1_CHANGE_0][0].value = 2500;
      L1_ESPLORA.utxos[L1_RECEIVE_0][1].value = 900;
    }
  });

  test("a lock forgets the last balances", async () => {
    await readHome(session, "l1");
    // A screen that reads no balance itself, so nothing refills the cache behind the test's back.
    const page = await openWalletPage(session, "#/grants");
    const ask = (message) => page.evaluate((m) => chrome.runtime.sendMessage(m), message);
    assert.ok((await ask({ kind: "l1.cached" })).result, "remembered while unlocked");
    await ask({ kind: "vault.lock" });
    await ask({ kind: "vault.unlock", password: WALLET_PASSWORD });
    assert.equal((await ask({ kind: "l1.cached" })).result, null, "forgotten by the lock");
    await page.close();
  });

  test("the home page adds up each chain's ECX into one total, names chains and assets by their Chain Entries, and counts nothing else", async () => {
    const page = await session.openPage("index.html#/");
    const home = await readTotal(page);
    await page.close();
    assert.equal(home.label, "Total across chains");
    assert.equal(home.total, "0.002815 ECX", "102 500 on the main chain + 179 000 on Elements+; the unnamed asset isn't counted");
    assert.equal(home.unconfirmed, "+0.000059 ECX unconfirmed", "900 + 5 000");
    assert.equal(home.unavailable, undefined);
    assert.equal(home.network, "betanet");
    assert.deepEqual(home.chains, [
      { name: "Main chain", subtotal: "0.001025 ECX", assets: [["ECX", "0.001025 ECX"]] },
      { name: "Elements+", subtotal: "0.00179 ECX", assets: [["ECX", "0.00179 ECX"], ["Unknown asset", "7"]] },
    ]);
  });

  test("tapping the total shows every ECX amount in sats, everywhere, until tapped again; the wallet remembers the pick", async () => {
    const page = await session.openPage("index.html#/");
    await readTotal(page);
    await page.click("[data-total]");
    await page.waitForSelector('[data-total][data-unit="sats"]');
    let home = await readTotal(page);
    assert.equal(home.total, "281,500 sats");
    assert.equal(home.unconfirmed, "+5,900 sats unconfirmed");
    assert.deepEqual(home.chains[1].assets, [["ECX", "179,000 sats"], ["Unknown asset", "7"]], "only ECX switches");
    await page.close();

    const again = await session.openPage("index.html#/");
    await again.waitForSelector('[data-total][data-unit="sats"]', { timeout: 10_000 });
    home = await readTotal(again);
    assert.equal(home.chains[0].subtotal, "102,500 sats", "remembered across pages");
    const chain = await openWalletPage(session, "#/chain/24");
    await chain.waitForSelector('[data-account="24"]:not([data-refreshing]) [data-balance]', { timeout: 20_000 });
    assert.equal(await chain.$eval("[data-total]", (e) => e.textContent.trim()), "179,000 sats", "and on a chain's own screen");
    await chain.close();
    await again.click("[data-total]");
    await again.waitForSelector('[data-total][data-unit="ecx"]');
    assert.equal((await readTotal(again)).total, "0.002815 ECX");
    await again.close();
  });

  test("a chain that can't be read is left out of the total, and says so", async () => {
    L1_ESPLORA.identityBlock = { ...L1_FORK_BLOCK, hash: BITCOIN_AT_FORK };
    await relock(session);
    try {
      const page = await session.openPage("index.html#/");
      const home = await readTotal(page);
      assert.equal(home.total, "0.00179 ECX");
      assert.equal(home.unavailable, "Main chain unavailable, not counted");
      L1_ESPLORA.identityBlock = L1_FORK_BLOCK;
      await page.click('[data-account="l1"] [data-retry]');
      await page.waitForFunction(() => document.querySelector("[data-unavailable]") === null, { timeout: 20_000 });
      assert.equal((await readTotal(page)).total, "0.002815 ECX", "Retry asks the server again");
      await page.close();
    } finally {
      L1_ESPLORA.identityBlock = L1_FORK_BLOCK;
    }
  });

  test("Send says sending isn't available yet, and asks the user for no approval", async () => {
    const page = await openWalletPage(session, "#/send/24");
    await page.waitForSelector(`[data-send-asset] option[value="${POLICY_ASSET}"]`, { timeout: 20_000 });
    await page.type("[data-send-amount]", "1000");
    await page.type("[data-send-destination]", FOREIGN_ADDRESS);
    await page.click("[data-send-submit]");
    await page.waitForSelector("[data-send-done], [data-error]", { timeout: 20_000 });
    const error = await page.evaluate(() => document.querySelector("[data-error]")?.textContent.trim());
    assert.equal(error, "Sending on Elements+ isn't available yet.");
    assert.equal((await session.approvalWindows()).length, 0);
    await page.close();
  });

  test("none of the above raised extension runtime errors", async () => {
    assert.deepEqual((await session.extensionErrors()).runtimeErrors, []);
  });
});
