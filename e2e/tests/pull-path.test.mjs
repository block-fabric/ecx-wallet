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
import { BROWSERS, launchWallet, openWalletPage, serveEsplora, serveL1Esplora, setUpWallet } from "../harness.mjs";

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
      // Unconfirmed: not counted.
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

/** One account card's reported balances (or why there are none), as a user reads them. */
async function readHome(session, account = "24") {
  const page = await session.openPage("index.html#/");
  await page.waitForSelector("[data-wallet-ready]", { timeout: 10_000 });
  const card = `[data-account="${account}"]`;
  await page.waitForSelector(`${card} :is([data-balance], [data-no-balance], [data-balance-error])`, { timeout: 20_000 });
  const shown = await page.evaluate((card) => {
    const text = (e) => e?.textContent.replace(/\s+/g, " ").trim();
    const within = document.querySelector(card);
    return {
      label: text(within.querySelector("[data-reported-by]")),
      error: text(within.querySelector("[data-balance-error]")),
      balances: [...within.querySelectorAll("[data-balance]")].map((e) => ({ asset: e.getAttribute("data-asset"), text: text(e) })),
      send: within.querySelector("[data-send-link]") !== null,
    };
  }, card);
  await page.close();
  return shown;
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

  test("the home page shows each asset's confirmed balance over the receive and change addresses, labelled as reported by the server", async () => {
    const shown = await readHome(session);
    assert.equal(shown.error, undefined);
    assert.match(shown.label, new RegExp(`Reported by ${stub.url.replace(/[.]/g, "\\.")}`));
    assert.deepEqual(shown.balances.map((b) => b.asset), [POLICY_ASSET, OTHER_ASSET]);
    assert.match(shown.balances[0].text, /\b179000\b/, "150 000 received + 29 000 change, not the unconfirmed 5 000");
    assert.match(shown.balances[1].text, /\b7\b/);

    const requests = stub.requests();
    assert.equal(requests[0], "/block-height/0", "the server's chain is checked first");
    for (const address of [RECEIVE_0, RECEIVE_1, CHANGE_0]) assert.ok(requests.includes(`/address/${address}/utxo`), `asked for ${address}`);
  });

  test("a server on another chain gives that Slot a hard error and no balance", async () => {
    ESPLORA.identityBlock = { height: 0, hash: "00".repeat(32) };
    try {
      const shown = await readHome(session);
      assert.deepEqual(shown.balances, []);
      assert.match(shown.error, /another chain/);
    } finally {
      ESPLORA.identityBlock = { height: 0, hash: GENESIS };
    }
  });

  test("the eCash card shows the confirmed sats of the L1 receive and change addresses, labelled as reported by its server", async () => {
    const shown = await readHome(session, "l1");
    assert.equal(shown.error, undefined);
    assert.match(shown.label, new RegExp(`Reported by ${l1Stub.url.replace(/[.]/g, "\\.")}`));
    assert.deepEqual(shown.balances.map((b) => b.asset), [""]);
    assert.match(shown.balances[0].text, /^102500 sats$/, "100 000 received + 2 500 change, not the unconfirmed 900");
    assert.equal(shown.send, false, "no Send on L1 yet");

    const requests = l1Stub.requests();
    assert.equal(requests[0], "/block-height/967680", "the fork block is checked first");
    for (const address of [L1_RECEIVE_0, L1_CHANGE_0]) assert.ok(requests.includes(`/address/${address}/utxo`), `asked for ${address}`);
  });

  test("an eCash server on Bitcoin's chain is a hard error for the eCash card only", async () => {
    L1_ESPLORA.identityBlock = { ...L1_FORK_BLOCK, hash: BITCOIN_AT_FORK };
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
    try {
      const shown = await readHome(session, "l1");
      assert.deepEqual(shown.balances, []);
      assert.match(shown.error, /hasn't synced to block 967680/);
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
    assert.equal(error, "Sending on Elements isn't available yet.");
    assert.equal((await session.approvalWindows()).length, 0);
    await page.close();
  });

  test("none of the above raised extension runtime errors", async () => {
    assert.deepEqual((await session.extensionErrors()).runtimeErrors, []);
  });
});
