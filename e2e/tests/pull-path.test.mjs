// Seam 1, pull path: the e2e build's wallet reads Slot 24's balance from its Sidechain Server, the
// stub Esplora server listening where that build's Chain Entry names betanet's server (the shipped
// build's is the Elements explorer; build-output.test checks that's the only difference). The stub
// sends no CORS headers, like the explorer: the wallet gets through on its host permission.
//
// The wallet imports "abandon … about". Its Slot 24 receive and change addresses are fixed
// vectors (core/elements/tests/elements.rs). The Standard Sidechain API's Send is tested in node,
// in sidechain-servers.test.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { BROWSERS, launchWallet, openWalletPage, serveEsplora, setUpWallet } from "../harness.mjs";

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

/** The home page's reported balances (or why there are none), as a user reads them. */
async function readHome(session) {
  const page = await session.openPage("index.html#/");
  await page.waitForSelector("[data-wallet-ready]", { timeout: 10_000 });
  await page.waitForSelector("[data-balance], [data-no-balance], [data-balance-error]", { timeout: 20_000 });
  const shown = await page.evaluate(() => {
    const text = (e) => e?.textContent.replace(/\s+/g, " ").trim();
    return {
      label: text(document.querySelector("[data-reported-by]")),
      error: text(document.querySelector("[data-balance-error]")),
      balances: [...document.querySelectorAll("[data-balance]")].map((e) => ({ asset: e.getAttribute("data-asset"), text: text(e) })),
    };
  });
  await page.close();
  return shown;
}

for (const browserName of BROWSERS) describe(browserName, () => {
  let session;
  let stub;
  before(async () => {
    [session, stub] = await Promise.all([launchWallet(browserName), serveEsplora(ESPLORA)]);
    await setUpWallet(session); // ABANDON, no passphrase
  });
  after(async () => {
    await session?.close();
    await stub?.close();
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
