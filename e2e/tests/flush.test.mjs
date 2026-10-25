// Flush (Slot 46) over its explorer, in node: the wallet's own TypeScript and the shipped flush.wasm
// against the Esplora stub in Flush mode (mempool.space's electrs fork plus `/flush/blocks`), with a
// scripted approval window instead of a browser. Balance, history, Send, finality and the stall
// (#56, docs/adr/0012). Fixtures are made here: no plain ECX transfer exists on the live chain.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { createEsploraStub } from "@ecx/stub-server/esplora";
import { encodeTx, parseTx } from "@ecx/stub-server/bitcoin-tx";
import { DIST, importWallet } from "../harness.mjs";

const wallet = await importWallet();
const flush = await wallet.loadChainModule(await readFile(path.join(DIST.chromium, "flush.wasm")));
const l1 = await wallet.loadL1Module(await readFile(path.join(DIST.chromium, "l1.wasm")));

const STARTER = "buyer citizen congress doll secret merry denial law live wait pass drive";
const FOREIGN = "blush cream bullet drive index disease noble east target dice put rate";
const CHAIN = "ecash:betanet-s46";
const { identityBlock } = flush.chainEntry().networks.betanet;
/** The temporary Slot 99 chain the live explorer serves: same HRP, another genesis. */
const SLOT_99_GENESIS = "04dfb01bef61e44d679132f9e830719c64241f7052880418a350ff6d3c90b561";

const account = flush.deriveAccount(STARTER, { receive: wallet.WATCHED_RECEIVE_ADDRESSES, change: wallet.WATCHED_CHANGE_ADDRESSES });
const [RECEIVE_0, RECEIVE_1] = account.receive;
const PAY_TO = flush.deriveAccount(FOREIGN, { receive: 1 }).receive[0].address;

const SOFT = "50".repeat(32);
const ANCHORED = "a0".repeat(32);
const FINAL = "f0".repeat(32);

/** A coinbase paying `outputs` (`[script, value]`): how Flush pays a Deposit, at `height`. */
const coinbase = (height, outputs) =>
  encodeTx({
    inputs: [{ txid: "00".repeat(32), vout: 0xffffffff, script: `03${height.toString(16).padStart(6, "0")}` }],
    outputs: outputs.map(([script, value]) => ({ script, value })),
  });

/** A plain transaction paying `outputs`, from a made-up input (`seed` keeps txids apart). */
const paying = (seed, outputs) => encodeTx({ inputs: [{ txid: seed.repeat(32), vout: 0 }], outputs: outputs.map(([script, value]) => ({ script, value })) });

const lockState = () => ({ unlocked: true, steps: [] });

describe("Flush", () => {
  const config = { flush: true, identityBlock, tipHeight: 500, feeEstimates: { 1: 1, 6: 0.1, 1008: 0.1 }, txs: [], utxos: {} };
  let stub;
  let url;
  before(async () => {
    stub = createEsploraStub(config);
    url = await stub.listen();
  });
  after(() => stub?.close());

  /** Flush's module with betanet's server on the stub. */
  function module() {
    const entry = structuredClone(flush.chainEntry());
    entry.networks.betanet.sidechainServer = { api: "flush", url };
    return { ...flush, chainEntry: () => structuredClone(entry) };
  }

  /** `txs` (with their blocks) in the stub, and each output they pay one of our addresses as a coin. */
  function fund(txs) {
    config.txs = txs;
    config.utxos = {};
    for (const { hex, confirmed = true, blockHash } of txs) {
      const tx = parseTx(hex);
      tx.outputs.forEach(({ script, value }, vout) => {
        const ours = [...account.receive, ...account.change].find((a) => a.scriptPubkey === script);
        if (ours) (config.utxos[ours.address] ??= []).push({ txid: tx.txid, vout, value, confirmed, blockHash });
      });
    }
  }

  function pullPathWith({ lock = lockState(), prompts = [] } = {}) {
    const flushModule = module();
    const deps = {
      supportedSlots: [46],
      chainModule: (slot) => (slot === 46 ? Promise.resolve(flushModule) : undefined),
      openSigningApproval: (context) => ({
        unlock: async () => true,
        confirm: async (prompt) => {
          prompts.push({ context, prompt });
          return true;
        },
        close() {},
      }),
      isUnlocked: async () => lock.unlocked,
      starter: async () => STARTER,
      l1Module: async () => l1,
      l1AccountKey: async () => assert.fail("Flush asked for the L1 Account Key"),
      now: () => Date.now(),
      sidechainServer: (entry, network) => wallet.sidechainServer(entry, network),
    };
    return { pullPath: wallet.createPullPath(deps), deps, prompts };
  }

  function sendsWith({ held = [] } = {}) {
    const { pullPath, deps, prompts } = pullPathWith();
    const sends = wallet.createSends({
      ...deps,
      pullPath,
      esplora: (entry, network) => wallet.esploraClient(wallet.esploraConfig(entry, network), (...args) => fetch(...args)),
      held: {
        list: async () => [...held],
        put: async (h) => void held.push(h),
        remove: async (txid) => void held.splice(held.findIndex((h) => h.txid === txid), 1),
      },
      now: () => Date.now(),
    });
    return { sends, prompts, held };
  }

  test("a server on the temporary Slot 99 chain fails the identity check", async () => {
    config.identityBlock = { height: 0, hash: SLOT_99_GENESIS };
    try {
      await assert.rejects(pullPathWith().pullPath.reportedState(46), /is on another chain: its genesis block is 04dfb01b/);
    } finally {
      config.identityBlock = identityBlock;
    }
  });

  test("the balance counts Deposit payouts in coinbases, and a block only once anchored", async () => {
    fund([
      { hex: coinbase(100, [["", 0], [RECEIVE_0.scriptPubkey, 100_000_000]]), blockHeight: 100, blockHash: FINAL },
      { hex: coinbase(490, [[RECEIVE_1.scriptPubkey, 2_000]]), blockHeight: 490, blockHash: ANCHORED },
      { hex: paying("e1", [[RECEIVE_0.scriptPubkey, 5_000]]), blockHeight: 499, blockHash: SOFT },
      // A token's output: value 0, counted as nothing.
      { hex: paying("e2", [[RECEIVE_1.scriptPubkey, 0]]), blockHeight: 300, blockHash: FINAL },
    ]);
    config.finality = { [SOFT]: "soft", [ANCHORED]: "anchored" };
    const report = await pullPathWith().pullPath.reportedState(46);
    assert.deepEqual(report.balances, [{ asset: "", amount: "100002000" }]);
    assert.deepEqual(report.unconfirmed, [{ asset: "", amount: "5000" }], "a soft block isn't confirmed yet");
    assert.equal(report.stalledSince, undefined);

    config.finality = {};
    assert.deepEqual((await pullPathWith().pullPath.reportedState(46)).balances, [{ asset: "", amount: "100007000" }]);
  });

  test("the history lists coinbase receipts and pages with after_txid past the first 25", async () => {
    fund(Array.from({ length: 40 }, (_, i) => ({ hex: coinbase(1000 + i, [[RECEIVE_0.scriptPubkey, 1_000 + i]]), blockHeight: 1000 + i, blockHash: FINAL })));
    const history = await pullPathWith().pullPath.history(46);
    assert.equal(history.entries.length, 40);
    assert.equal(history.partial, false);
    assert.deepEqual(history.entries[0].amounts, [{ asset: "", amount: "1039" }], "newest first");
    assert.ok(stub.requests().some((p) => p.endsWith("/txs/chain/" + history.entries[24].txid)), "Blockstream's paging was tried first");
  });

  test("a Send builds from whole transactions, never spends a value-0 output, and goes out without a replay marker", async () => {
    const coin = paying("c1", [[RECEIVE_0.scriptPubkey, 100_000]]);
    const token = paying("c2", [[RECEIVE_1.scriptPubkey, 0]]);
    fund([
      { hex: coin, blockHeight: 400, blockHash: FINAL },
      { hex: token, blockHeight: 401, blockHash: FINAL },
    ]);
    const { sends, prompts, held } = sendsWith();
    const before = stub.broadcasts().length;
    const result = await sends.send(46, { outputs: [{ asset: "", amount: "40000", to: { address: PAY_TO } }] });

    assert.equal(prompts.length, 1);
    assert.deepEqual(prompts[0].context, { origin: "This wallet (Send on Flush)", chain: CHAIN });
    const { view } = prompts[0].prompt.decoded;
    assert.equal(prompts[0].prompt.decoded.kind, "clear");
    assert.deepEqual(view.outputs[0], { index: 0, asset: "", amount: "40000", destination: { kind: "address", address: PAY_TO, yours: false } });
    assert.equal(view.outputs[1].destination.yours, true, "change comes back");
    // 0.1 sat/vB estimates: the module pays 1 sat/vB, about 141 vB here.
    assert.ok(Number(view.fee.amount) >= 141, `fee ${view.fee.amount}`);

    assert.equal(stub.broadcasts().length, before + 1);
    const tx = parseTx(stub.broadcasts().at(-1));
    assert.deepEqual(result, { server: url, accepted: true, txid: tx.txid });
    assert.equal(tx.locktime, 0, "no replay marker on Flush (docs/adr/0011)");
    assert.deepEqual(tx.inputs.map((i) => i.txid), [parseTx(coin).txid], "the value-0 output is never spent");
    assert.equal(tx.inputs[0].witness.length, 2, "signed by flush.wasm");
    assert.deepEqual(held, [{ slot: 46, txid: tx.txid, spent: [{ txid: parseTx(coin).txid, vout: 0 }], tipHeight: 500 }]);
  });

  test("a coin someone else paid in a soft block isn't spent until its block is anchored", async () => {
    fund([{ hex: paying("d1", [[RECEIVE_0.scriptPubkey, 70_000]]), blockHeight: 499, blockHash: SOFT }]);
    config.finality = { [SOFT]: "soft" };
    try {
      assert.deepEqual(await sendsWith().sends.spendable(46), []);
      config.finality = { [SOFT]: "anchored" };
      assert.deepEqual(await sendsWith().sends.spendable(46), [{ asset: "", amount: "70000" }]);
    } finally {
      config.finality = {};
    }
  });

  test("a server that sends another transaction than the coin it listed sends nothing", async () => {
    const coin = paying("c3", [[RECEIVE_0.scriptPubkey, 100_000]]);
    fund([{ hex: coin, blockHeight: 400, blockHash: FINAL }]);
    // Another transaction paying the same address: it would spend a coin the server never listed.
    config.txHexOverrides = { [parseTx(coin).txid]: paying("c4", [[RECEIVE_0.scriptPubkey, 100_000]]) };
    const before = stub.broadcasts().length;
    try {
      await assert.rejects(sendsWith().sends.send(46, { outputs: [{ asset: "", amount: "1000", to: { address: PAY_TO } }] }), /isn't one it listed/);
      assert.equal(stub.broadcasts().length, before);
    } finally {
      config.txHexOverrides = undefined;
    }
  });

  test("a chain with no block for 5 minutes is reported stalled", async () => {
    fund([]);
    const tipTime = Math.floor(Date.now() / 1000) - wallet.FLUSH_STALL_SECONDS - 60;
    config.tipTime = tipTime;
    try {
      assert.equal((await pullPathWith().pullPath.reportedState(46)).stalledSince, tipTime);
    } finally {
      config.tipTime = undefined;
    }
  });

  test("the explorer's errors read as its own words", async () => {
    const client = wallet.esploraClient(wallet.esploraConfig(module().chainEntry(), module().chainEntry().networks.betanet), (...args) => fetch(...args));
    // `{"error": …}`, not the JSON itself.
    await assert.rejects(client.tx("ab".repeat(32)), /refused: No such mempool or blockchain transaction$/);
    await assert.rejects(client.blockHash(99_999), /refused: Failed to get block at height$/);
  });
});
