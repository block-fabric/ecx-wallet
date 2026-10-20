// The pull path over each Server API, in node: the wallet's own TypeScript and the shipped
// elements.wasm against the stub servers, with a scripted approval window instead of a browser.
//
// - Standard Sidechain API (`ecx-v0`): no bundled chain speaks it in v0 (docs/adr/0002), so this is
//   where its client, the server-built Send and that Send's refusals are tested.
// - Esplora: the edge cases of reading a balance; pull-path.test covers it in the browsers.
//
// Slot 24's Chain Module is the shipped one with its Chain Entry's betanet server swapped for the
// stub under test. Payloads are the fixture PSETs from core/elements/tests/fixtures.rs.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { createEsploraStub } from "@ecx/stub-server/esplora";
import { DIST, ROOT, importWallet, serveSidechainServer } from "../harness.mjs";

const PSETS = JSON.parse(await readFile(path.join(ROOT, "e2e", "fixtures", "elements-psets.json"), "utf8"));
const SLOT_24_STARTER = "buyer citizen congress doll secret merry denial law live wait pass drive";
const CHAIN = "ecash:betanet-s24";
const GENESIS = "a7754ce0debc40baddbd8c47e79d19209685f22c63edaaf8b69cf54116374d7f";
const RECEIVE_0 = "elements1qew44aehkjstjm56ng2rjrz57vwxh5g9su6dlpm";
const RECEIVE_1 = "elements1qnx6kczxpu35ypahwhqddx2pn6q0nuyaap97ygn";
const CHANGE_0 = "elements1q2n6usykz5ycrnfpup3hx0qa0manae07jgvvmuc";
const POLICY_ASSET = "5836dcc06130dcf6a65b6ac493813fd65559955283e44cc3f07966294eccb2c8";
const OTHER_ASSET = "1111111111111111111111111111111111111111111111111111111111111111";
// The `clear` fixture pays this foreign address 120 000 and sends 29 000 change back to us.
const FOREIGN_ADDRESS = "elements1qepkhlwlq2qjggg89d5quqx8z59vz9mr2h6j4pc";

const wallet = await importWallet();
const elements = await wallet.loadChainModule(await readFile(path.join(DIST.chromium, "elements.wasm")));

/**
 * The pull path for Slot 24 with betanet's server set to `server`. `approve` answers each approval
 * window; `prompts` records what each one was opened for and shown.
 */
function pullPathWith(server, { approve = true } = {}) {
  const entry = structuredClone(elements.chainEntry());
  entry.networks.betanet.sidechainServer = server;
  const module = { ...elements, chainEntry: () => structuredClone(entry) };
  const prompts = [];
  const pullPath = wallet.createPullPath({
    supportedSlots: [24],
    chainModule: (slot) => (slot === 24 ? Promise.resolve(module) : undefined),
    openSigningApproval: (context) => ({
      unlock: async () => true,
      confirm: async (prompt) => {
        prompts.push({ context, prompt });
        return approve;
      },
      close() {},
    }),
    isUnlocked: async () => true,
    starter: async () => SLOT_24_STARTER,
    now: () => Date.now(),
    sidechainServer: (chainEntry, network) => wallet.sidechainServer(chainEntry, network),
  });
  return { pullPath, prompts };
}

describe("Standard Sidechain API", () => {
  let stub;
  before(async () => {
    stub = await serveSidechainServer({
      state: {
        [RECEIVE_0]: {
          balances: [
            { asset: POLICY_ASSET, amount: "150000" },
            { asset: OTHER_ASSET, amount: "7" },
          ],
          history: [{ txid: "aa".repeat(32), amounts: [{ asset: POLICY_ASSET, amount: "150000" }] }],
        },
      },
      // Each amount picks a fixture; a real server builds the transfer it's asked for.
      transfers: [
        { asset: POLICY_ASSET, amount: "120000", destination: FOREIGN_ADDRESS, payload: PSETS.clear.payload },
        { asset: POLICY_ASSET, amount: "2", destination: FOREIGN_ADDRESS, payload: PSETS.blind.payload },
        { asset: POLICY_ASSET, amount: "3", destination: FOREIGN_ADDRESS, payload: PSETS.wrongGenesis.payload },
        { asset: POLICY_ASSET, amount: "4", destination: FOREIGN_ADDRESS, payload: PSETS.clear.payload, expiresIn: -60 },
        { asset: POLICY_ASSET, amount: "5", destination: FOREIGN_ADDRESS, payload: PSETS.confidentialInput.payload },
        { asset: POLICY_ASSET, amount: "6", destination: FOREIGN_ADDRESS, payload: PSETS.confidentialOutput.payload },
      ],
    });
  });
  after(() => stub?.close());

  const server = () => ({ api: "ecx-v0", url: stub.url });
  const send = (pullPath, amount) => pullPath.send(24, { asset: POLICY_ASSET, amount, destination: FOREIGN_ADDRESS });

  test("the reported state comes after registering the descriptor and the receive addresses", async () => {
    const report = await pullPathWith(server()).pullPath.reportedState(24);
    assert.equal(report.server, stub.url);
    assert.deepEqual(report.balances, [
      { asset: POLICY_ASSET, amount: "150000" },
      { asset: OTHER_ASSET, amount: "7" },
    ]);
    assert.equal(report.history.length, 1);

    const registration = stub.registrations().at(-1);
    assert.equal(registration.chain, CHAIN);
    assert.match(registration.descriptor, /^elwpkh\(\[3b27f87d\/84h\/1h\/0h\]tpub/);
    assert.equal(registration.addresses.length, wallet.WATCHED_RECEIVE_ADDRESSES);
    assert.deepEqual(registration.addresses.slice(0, 2).map((a) => a.address), [RECEIVE_0, RECEIVE_1]);
    assert.ok(!registration.addresses.some((a) => a.address === CHANGE_0), "the server derives change from the descriptor");
  });

  test("Send: the server builds the transfer, the approval names the server, and the signed payload goes back", async () => {
    const { pullPath, prompts } = pullPathWith(server());
    const result = await send(pullPath, "120000");
    assert.equal(result.accepted, true);
    assert.equal(result.server, stub.url);
    assert.equal(prompts.length, 1);
    assert.deepEqual(prompts[0].context, { origin: stub.url, chain: CHAIN });
    assert.equal(prompts[0].prompt.decoded.kind, "clear");
    assert.equal(prompts[0].prompt.decoded.view.outputs[0].destination.address, FOREIGN_ADDRESS);
    const submitted = stub.submissions().at(-1);
    assert.equal(submitted.requestId, result.requestId);
    assert.equal(submitted.payload, PSETS.clear.signed, "the same PSET, signed on our input only");
  });

  test("Send: rejecting the approval submits nothing", async () => {
    const before = stub.submissions().length;
    await assert.rejects(send(pullPathWith(server(), { approve: false }).pullPath, "120000"), /rejected/i);
    assert.equal(stub.submissions().length, before);
  });

  test("Send: a server-built request the Decoder can't fully explain is refused without an approval", async () => {
    const before = stub.submissions().length;
    const { pullPath, prompts } = pullPathWith(server());
    await assert.rejects(send(pullPath, "2"), /Clear Signed/);
    assert.equal(prompts.length, 0, "never shown, so never Blind-signed");
    assert.equal(stub.submissions().length, before);
  });

  for (const [what, amount, message] of [
    ["a wrong genesis", "3", /genesis/i],
    ["an expired expiresAt", "4", /expired/i],
    ["a confidential input", "5", /confidential/i],
    ["a confidential output", "6", /confidential/i],
  ]) {
    test(`Send: a server-built request with ${what} is refused`, async () => {
      const before = stub.submissions().length;
      const { pullPath, prompts } = pullPathWith(server());
      await assert.rejects(send(pullPath, amount), message);
      assert.equal(prompts.length, 0);
      assert.equal(stub.submissions().length, before);
    });
  }
});

describe("Esplora", () => {
  const config = { genesisHash: GENESIS, utxos: {} };
  let stub;
  let url;
  before(async () => {
    stub = createEsploraStub(config);
    url = await stub.listen();
  });
  after(() => stub?.close());

  const reported = () => pullPathWith({ api: "esplora", url }).pullPath.reportedState(24);

  test("the balance is the confirmed explicit outputs of the receive and change addresses, per asset", async () => {
    config.utxos = {
      [RECEIVE_0]: [
        { txid: "a0".repeat(32), vout: 0, value: 150000, asset: POLICY_ASSET, confirmed: true },
        { txid: "a1".repeat(32), vout: 0, value: 5000, asset: POLICY_ASSET, confirmed: false },
      ],
      [RECEIVE_1]: [{ txid: "a2".repeat(32), vout: 1, value: 7, asset: OTHER_ASSET, confirmed: true }],
      [CHANGE_0]: [
        { txid: "a3".repeat(32), vout: 1, value: 29000, asset: POLICY_ASSET, confirmed: true },
        { txid: "a4".repeat(32), vout: 2, valuecommitment: `08${"11".repeat(32)}`, assetcommitment: `0a${"22".repeat(32)}`, confirmed: true },
      ],
    };
    const report = await reported();
    assert.equal(report.server, url);
    assert.deepEqual(report.balances, [
      { asset: POLICY_ASSET, amount: "179000" },
      { asset: OTHER_ASSET, amount: "7" },
    ]);
    assert.deepEqual(report.history, []);
    const queried = stub.requests().filter((p) => p.endsWith("/utxo")).length;
    assert.equal(queried, wallet.WATCHED_RECEIVE_ADDRESSES + wallet.WATCHED_CHANGE_ADDRESSES);
  });

  test("a server on another chain is a hard error, and nothing else is asked of it", async () => {
    config.genesisHash = "00".repeat(32);
    const before = stub.requests().length;
    try {
      await assert.rejects(reported(), (e) => e instanceof wallet.SidechainServerError && /another chain/.test(e.message));
      assert.deepEqual(stub.requests().slice(before), ["/block-height/0"]);
    } finally {
      config.genesisHash = GENESIS;
    }
  });

  test("an answer that isn't a list of outputs is refused", async () => {
    config.utxos = { [RECEIVE_0]: [{ txid: "a0".repeat(32), vout: 0, value: "150000", asset: POLICY_ASSET, confirmed: true }] };
    await assert.rejects(reported(), /malformed output/);
  });

  test("an unreachable server says so", async () => {
    const { pullPath } = pullPathWith({ api: "esplora", url: "http://127.0.0.1:9" });
    await assert.rejects(pullPath.reportedState(24), /Couldn't reach the Sidechain Server at http:\/\/127\.0\.0\.1:9/);
  });

  test("Send isn't available yet", async () => {
    const { pullPath, prompts } = pullPathWith({ api: "esplora", url });
    await assert.rejects(
      pullPath.send(24, { asset: POLICY_ASSET, amount: "1000", destination: FOREIGN_ADDRESS }),
      (e) => e instanceof wallet.SidechainServerError && e.message === "Sending on Elements isn't available yet.",
    );
    assert.equal(prompts.length, 0);
  });
});

test("a Chain Entry naming a Server API the wallet doesn't speak is refused", async () => {
  const { pullPath } = pullPathWith({ api: "electrum", url: "http://127.0.0.1:9" });
  await assert.rejects(pullPath.reportedState(24), /Server API this wallet doesn't speak: electrum/);
});
