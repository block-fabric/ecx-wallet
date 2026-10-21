// Seam 1, transaction history (#33): each chain's History screen (`#/history/<chain>`, linked from
// its home card) lists the transactions touching the addresses the wallet watches, as its Sidechain
// Server reports them: the wallet's net change per asset, pending or confirmed, and the txid.
//
// eCash's server is the stub Esplora server, which lists an address's transactions from the raw
// transactions in its `txs` (made-up inputs), as an indexer would.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { addressScript, encodeTx, parseTx } from "@ecx/stub-server/bitcoin-tx";
import { BROWSERS, homeSettled, launchWallet, openWalletPage, serveEsplora, serveL1Esplora, setUpWallet } from "../harness.mjs";

const GENESIS = "a7754ce0debc40baddbd8c47e79d19209685f22c63edaaf8b69cf54116374d7f";
const L1_FORK_BLOCK = { height: 967680, hash: "00000000000000030101ba5cfea54b22becc79f95dc6040beb76e01dd9d04042" };
const L1_RECEIVE_0 = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
const L1_CHANGE_0 = "bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el";
/** Slot 24's first receive address: where its Deposits are credited. */
const RECEIVE_0 = "elements1qew44aehkjstjm56ng2rjrz57vwxh5g9su6dlpm";
const RECEIVE_1 = "elements1qnx6kczxpu35ypahwhqddx2pn6q0nuyaap97ygn";
const CHANGE_0 = "elements1q2n6usykz5ycrnfpup3hx0qa0manae07jgvvmuc";
const POLICY_ASSET = "5836dcc06130dcf6a65b6ac493813fd65559955283e44cc3f07966294eccb2c8";
const OTHER_ASSET = "1111111111111111111111111111111111111111111111111111111111111111";
/** betanet's Slot 24 Treasury script, `OP_NOP8 <24> OP_TRUE`. */
const TREASURY = "b7011851";
/** An M5's address output: `OP_RETURN <48 bytes>`. */
const ADDRESS_OUTPUT = `6a30${Buffer.from(RECEIVE_0, "utf8").toString("hex")}`;
/** Someone else's script. */
const FOREIGN = "0014" + "ab".repeat(20);

/** A transaction from made-up inputs (`seed` keeps txids apart); confirmed at `blockHeight` unless `confirmed: false`. */
const tx = (seed, outputs, { inputs, confirmed = true, blockHeight = 970800, blockTime = 1792000000 } = {}) => {
  const hex = encodeTx({ inputs: inputs ?? [{ txid: seed.repeat(32), vout: 0 }], outputs });
  return { hex, txid: parseTx(hex).txid, confirmed, blockHeight, blockTime };
};

/** What eCash's stub holds (read on every request); each test sets `txs`. */
const L1 = { identityBlock: L1_FORK_BLOCK, txs: [] };
const ESPLORA = { identityBlock: { height: 0, hash: GENESIS } };

/** The History screen's entries once refreshed, as a user reads them. */
async function readHistory(session, chain) {
  const page = await openWalletPage(session, `#/history/${chain}`);
  await page.waitForSelector("[data-history]:not([data-refreshing])", { timeout: 20_000 });
  const shown = await page.evaluate(() => {
    const text = (e) => e?.textContent.replace(/\s+/g, " ").trim();
    return {
      label: text(document.querySelector("[data-reported-by]")),
      error: text(document.querySelector("[data-history-error]")),
      empty: text(document.querySelector("[data-history-empty]")),
      more: text(document.querySelector("[data-history-more]")),
      entries: [...document.querySelectorAll("[data-history-entry]")].map((e) => ({
        txid: e.getAttribute("data-history-entry"),
        state: e.getAttribute("data-history-state"),
        amounts: [...e.querySelectorAll("[data-history-amount]")].map(text),
        status: text(e.querySelector("[data-history-status]")),
        time: e.querySelector("[data-history-status] time")?.getAttribute("datetime"),
        warning: e.querySelector("[data-history-status]")?.getAttribute("title") ?? undefined,
        label: text(e.querySelector("[data-history-label]")),
        hidden: text(e.querySelector("[data-history-hidden]")),
        shownTxid: e.querySelector("[data-history-txid]")?.getAttribute("title"),
      })),
    };
  });
  await page.close();
  return shown;
}

for (const browserName of BROWSERS) describe(browserName, () => {
  let session;
  let l1Stub;
  let stub;
  before(async () => {
    [session, l1Stub, stub] = await Promise.all([launchWallet(browserName), serveL1Esplora(L1), serveEsplora(ESPLORA)]);
    await setUpWallet(session);
  });
  after(async () => {
    await session?.close();
    await l1Stub?.close();
    await stub?.close();
  });
  beforeEach(() => {
    L1.txs = [];
  });

  test("eCash's History shows a received transaction: +N sats, when it confirmed, and its txid, labelled as reported by the server", async () => {
    const received = tx("c0", [{ value: 40000, script: addressScript(L1_RECEIVE_0) }, { value: 9000, script: FOREIGN }]);
    L1.txs = [received];
    const shown = await readHistory(session, "l1");
    assert.equal(shown.error, undefined);
    assert.match(shown.label, new RegExp(`Reported by ${l1Stub.url.replace(/[.]/g, "\\.")}`));
    assert.equal(shown.entries.length, 1);
    const [entry] = shown.entries;
    assert.equal(entry.txid, received.txid);
    assert.equal(entry.state, "confirmed");
    assert.deepEqual(entry.amounts, ["+40000 sats"], "only what reached the wallet's address");
    assert.equal(entry.time, new Date(1792000000 * 1000).toISOString(), "the block's time");
    assert.equal(entry.shownTxid, received.txid);
    assert.equal(shown.more, undefined, "nothing older left out");
  });

  test("a spend shows what left the wallet, fee included, once, though it touches two of its addresses; newest first", async () => {
    const funding = tx("c1", [{ value: 50000, script: addressScript(L1_RECEIVE_0) }], { blockHeight: 970800 });
    const spend = tx("", [{ value: 30000, script: FOREIGN }, { value: 19000, script: addressScript(L1_CHANGE_0) }], {
      inputs: [{ txid: funding.txid, vout: 0 }],
      blockHeight: 970801,
    });
    L1.txs = [funding, spend];
    const shown = await readHistory(session, "l1");
    assert.deepEqual(shown.entries.map((e) => [e.txid, e.amounts]), [
      [spend.txid, ["−31000 sats"]],
      [funding.txid, ["+50000 sats"]],
    ]);
    assert.equal(shown.entries[0].label, undefined);
  });

  test("a transfer to yourself shows the fee it cost, labelled as such", async () => {
    const funding = tx("c2", [{ value: 50000, script: addressScript(L1_RECEIVE_0) }], { blockHeight: 970800 });
    const consolidation = tx("", [{ value: 49000, script: addressScript(L1_CHANGE_0) }], {
      inputs: [{ txid: funding.txid, vout: 0 }],
      blockHeight: 970801,
    });
    L1.txs = [funding, consolidation];
    const [entry] = (await readHistory(session, "l1")).entries;
    assert.equal(entry.txid, consolidation.txid);
    assert.deepEqual(entry.amounts, ["−1000 sats"]);
    assert.equal(entry.label, "Fee, to yourself");
  });

  test("a Deposit is labelled with its Slot; a Withdrawal paid out of the Treasury isn't", async () => {
    const funding = tx("c3", [{ value: 50000, script: addressScript(L1_RECEIVE_0) }], { blockHeight: 970800 });
    const oldTreasury = tx("c4", [{ value: 100000, script: TREASURY }, { value: 0, script: ADDRESS_OUTPUT }], { blockHeight: 970800 });
    const deposit = tx("", [{ value: 120000, script: TREASURY }, { value: 0, script: ADDRESS_OUTPUT }, { value: 9000, script: addressScript(L1_CHANGE_0) }], {
      inputs: [{ txid: oldTreasury.txid, vout: 0 }, { txid: funding.txid, vout: 0 }],
      blockHeight: 970801,
    });
    // An M6: the Treasury pays a Withdrawal to the wallet, and keeps the rest at output 0.
    const withdrawal = tx("", [{ value: 100000, script: TREASURY }, { value: 15000, script: addressScript(L1_RECEIVE_0) }], {
      inputs: [{ txid: deposit.txid, vout: 0 }],
      blockHeight: 970802,
    });
    L1.txs = [funding, oldTreasury, deposit, withdrawal];
    const shown = await readHistory(session, "l1");
    assert.deepEqual(shown.entries.map((e) => [e.txid, e.amounts, e.label]), [
      [withdrawal.txid, ["+15000 sats"], undefined],
      [deposit.txid, ["−41000 sats"], "Deposit to Slot 24"],
      [funding.txid, ["+50000 sats"], undefined],
    ]);
  });

  test("unconfirmed transactions come first: 'Pending' if they spend only the wallet's own coins, else 'Unconfirmed', with a warning", async () => {
    const funding = tx("c5", [{ value: 50000, script: addressScript(L1_RECEIVE_0) }], { blockHeight: 970800 });
    const ownSpend = tx("", [{ value: 30000, script: FOREIGN }, { value: 19000, script: addressScript(L1_CHANGE_0) }], {
      inputs: [{ txid: funding.txid, vout: 0 }],
      confirmed: false,
    });
    const incoming = tx("c6", [{ value: 8000, script: addressScript(L1_RECEIVE_0) }], { confirmed: false });
    // The wallet's own spend, but of a coin someone else's unconfirmed transaction paid it.
    const spendOfIncoming = tx("", [{ value: 7000, script: addressScript(L1_CHANGE_0) }], {
      inputs: [{ txid: incoming.txid, vout: 0 }],
      confirmed: false,
    });
    L1.txs = [funding, ownSpend, incoming, spendOfIncoming];
    const shown = await readHistory(session, "l1");
    const byTxid = Object.fromEntries(shown.entries.map((e) => [e.txid, e]));
    assert.deepEqual(shown.entries.map((e) => e.txid).slice(3), [funding.txid], "the confirmed one last");
    assert.equal(byTxid[ownSpend.txid].state, "pending");
    assert.equal(byTxid[ownSpend.txid].status, "Pending");
    assert.equal(byTxid[incoming.txid].state, "unconfirmed");
    assert.equal(byTxid[incoming.txid].status, "Unconfirmed");
    assert.equal(byTxid[incoming.txid].warning, "Sent by someone else; may still not arrive");
    assert.equal(byTxid[spendOfIncoming.txid].state, "unconfirmed", "its parent isn't trusted");
  });

  test("Slot 24's History shows the net change per asset; an amount of the wallet's that's confidential is said not to be shown", async () => {
    const spendTxid = "e1".repeat(32);
    const receiveTxid = "e0".repeat(32);
    const confirmedAt = { confirmed: true, block_height: 2001, block_hash: "00".repeat(32), block_time: 1792000600 };
    const received = {
      txid: receiveTxid,
      vin: [{ txid: "d0".repeat(32), vout: 0, prevout: { scriptpubkey: FOREIGN, value: 200000, asset: POLICY_ASSET }, is_coinbase: false }],
      vout: [
        { scriptpubkey: addressScript(RECEIVE_0), value: 150000, asset: POLICY_ASSET },
        { scriptpubkey: addressScript(RECEIVE_1), value: 7, asset: OTHER_ASSET },
        // Blinded: commitments, no value or asset.
        { scriptpubkey: addressScript(RECEIVE_1), valuecommitment: "08" + "11".repeat(32), assetcommitment: "0a" + "22".repeat(32) },
        { scriptpubkey: "", value: 300, asset: POLICY_ASSET },
      ],
      status: { confirmed: true, block_height: 2000, block_hash: "00".repeat(32), block_time: 1792000000 },
    };
    const spend = {
      txid: spendTxid,
      vin: [{ txid: receiveTxid, vout: 0, prevout: { scriptpubkey: addressScript(RECEIVE_0), value: 150000, asset: POLICY_ASSET }, is_coinbase: false }],
      vout: [
        { scriptpubkey: FOREIGN, value: 100000, asset: POLICY_ASSET },
        { scriptpubkey: addressScript(CHANGE_0), value: 49700, asset: POLICY_ASSET },
        { scriptpubkey: "", value: 300, asset: POLICY_ASSET },
      ],
      status: confirmedAt,
    };
    ESPLORA.addressTxs = { [RECEIVE_0]: [spend, received], [RECEIVE_1]: [received], [CHANGE_0]: [spend] };
    try {
      const shown = await readHistory(session, "24");
      assert.equal(shown.error, undefined);
      assert.deepEqual(shown.entries.map((e) => e.txid), [spendTxid, receiveTxid]);
      const [out, into] = shown.entries;
      assert.deepEqual(out.amounts.map((a) => a.split(" ")[0]), ["−100300"]);
      assert.equal(out.hidden, undefined);
      assert.deepEqual(into.amounts.map((a) => a.split(" ")[0]), ["+150000", "+7"]);
      assert.match(into.amounts[0], /asset 5836dcc0…4eccb2c8$/);
      assert.equal(into.hidden, "+ confidential amounts not shown");
    } finally {
      delete ESPLORA.addressTxs;
    }
  });

  test("when an address has more transactions than the server lists at once, the list says older ones may not be shown", async () => {
    L1.txs = Array.from({ length: 26 }, (_, i) =>
      tx(`${i}`.padStart(2, "0"), [{ value: 1000 + i, script: addressScript(L1_RECEIVE_0) }], { blockHeight: 970000 + i }),
    );
    const shown = await readHistory(session, "l1");
    assert.equal(shown.entries.length, 25, "Esplora's latest 25");
    assert.deepEqual(shown.entries[0].amounts, ["+1025 sats"]);
    assert.equal(shown.more, "Older transactions may not be shown.");
  });

  test("with no transactions, it says so", async () => {
    const shown = await readHistory(session, "l1");
    assert.equal(shown.error, undefined);
    assert.deepEqual(shown.entries, []);
    assert.equal(shown.empty, "No transactions yet.");
  });

  test("it shows this session's last history at once while refreshing; if the refresh fails, it keeps it and says why", async () => {
    const received = tx("c7", [{ value: 40000, script: addressScript(L1_RECEIVE_0) }]);
    L1.txs = [received];
    await readHistory(session, "l1"); // now remembered
    L1.delayMs = 1500;
    L1.addressTxs = { [L1_RECEIVE_0]: { not: "a list" } };
    try {
      const page = await openWalletPage(session, "#/history/l1");
      await page.waitForSelector("[data-history][data-refreshing] [data-history-entry]", { timeout: 10_000 });
      assert.match(await page.$eval("[data-read-at]", (e) => e.textContent.replace(/\s+/g, " ").trim()), /^Last read at .+; refreshing…$/);
      await page.waitForSelector("[data-history]:not([data-refreshing])", { timeout: 20_000 });
      const shown = await page.evaluate(() => ({
        error: document.querySelector("[data-history-error]")?.textContent.replace(/\s+/g, " ").trim(),
        entries: [...document.querySelectorAll("[data-history-entry]")].map((e) => e.getAttribute("data-history-entry")),
      }));
      await page.close();
      assert.deepEqual(shown.entries, [received.txid]);
      assert.match(shown.error, /^Couldn't refresh: The Sidechain Server at .+ sent a malformed list of transactions\.$/);
    } finally {
      L1.delayMs = 0;
      delete L1.addressTxs;
    }
  });

  test("each home card links to its chain's History", async () => {
    const page = await session.openPage("index.html#/");
    await page.waitForSelector('[data-account="24"] [data-history-link]', { timeout: 10_000 });
    const links = await page.$$eval("[data-account]", (cards) =>
      cards.map((card) => [card.getAttribute("data-account"), card.querySelector("[data-history-link]")?.getAttribute("href")]),
    );
    await homeSettled(page);
    await page.close();
    assert.deepEqual(links, [
      ["l1", "#/history/l1"],
      ["24", "#/history/24"],
    ]);
  });

  test("none of the above raised extension runtime errors", async () => {
    assert.deepEqual((await session.extensionErrors()).runtimeErrors, []);
  });
});
