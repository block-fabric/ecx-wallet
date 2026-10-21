// `sendTransfer` at the Provider (#39, docs/adr/0006), no browser needed: an app names outputs and
// the wallet's own Send does the rest. The Send itself is tested in sidechain-servers.test; here,
// what the Provider adds: its own Grant, the app's origin, and what the app gets back.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { importWallet } from "../harness.mjs";

const { createProviderHandler, SidechainServerError } = await importWallet();

const ORIGIN = "https://dex.example";
const OUTPUTS = [{ asset: "5836dcc06130dcf6a65b6ac493813fd65559955283e44cc3f07966294eccb2c8", amount: "1000", to: { address: "elements1q…" } }];

/** A Provider handler over fakes: Slot 24 supported and on; `send` answers with `result`. */
function provider({ grant, unlocked = true, result = { server: "https://explorer.example", accepted: true, txid: "ab".repeat(32) } } = {}) {
  const sent = [];
  const handle = createProviderHandler({
    grants: {
      get: async (o) => (grant?.origin === o ? grant : undefined),
      put: async () => {},
      remove: async () => {},
      list: async () => (grant ? [grant] : []),
    },
    supportedSlots: [24],
    isUnlocked: async () => unlocked,
    now: () => Date.now(),
    chains: { isOn: async () => true, turnOn: async () => {} },
    askToConnect: async () => assert.fail("asked to connect"),
    askToTurnOn: async () => assert.fail("asked to turn a chain on"),
    receiveAddresses: async () => assert.fail("asked for addresses"),
    send: async (slot, order, from) => {
      sent.push({ slot, order, from });
      return result;
    },
  });
  return { handle, sent };
}

const granted = (methods, slots = [24]) => ({ origin: ORIGIN, slots, methods, blindSigning: false });

describe("sendTransfer", () => {
  test("hands the outputs to the wallet's Send, naming the app, and answers the txid", async () => {
    const { handle, sent } = provider({ grant: granted(["sendTransfer"]) });
    assert.deepEqual(await handle(ORIGIN, "sendTransfer", { slot: 24, outputs: OUTPUTS }), { txid: "ab".repeat(32) });
    assert.deepEqual(sent, [{ slot: 24, order: { outputs: OUTPUTS }, from: { origin: ORIGIN } }]);
  });

  test("needs its own Grant: signTransaction's doesn't cover it", async () => {
    const { handle, sent } = provider({ grant: granted(["getAddresses", "signTransaction"]) });
    await assert.rejects(handle(ORIGIN, "sendTransfer", { slot: 24, outputs: OUTPUTS }), (e) => e.code === 4100 && /no Grant for sendTransfer/.test(e.message));
    assert.deepEqual(sent, []);
  });

  test("needs the Slot in the Grant", async () => {
    const { handle, sent } = provider({ grant: granted(["sendTransfer"], [9]) });
    await assert.rejects(handle(ORIGIN, "sendTransfer", { slot: 24, outputs: OUTPUTS }), (e) => e.code === 4100 && /Slot 24/.test(e.message));
    assert.deepEqual(sent, []);
  });

  test("a missing Slot is invalid params, naming the method", async () => {
    const { handle } = provider({ grant: granted(["sendTransfer"]) });
    await assert.rejects(handle(ORIGIN, "sendTransfer", { outputs: OUTPUTS }), (e) => e.code === -32602 && /^sendTransfer needs `slot`/.test(e.message));
  });

  test("works while locked, unlike getAddresses: the Send's approval window unlocks first", async () => {
    const { handle, sent } = provider({ grant: granted(["sendTransfer"]), unlocked: false });
    assert.deepEqual(await handle(ORIGIN, "sendTransfer", { slot: 24, outputs: OUTPUTS }), { txid: "ab".repeat(32) });
    assert.equal(sent.length, 1);
  });

  test("a `/v1` server that doesn't accept the transaction is a Sidechain Server error", async () => {
    const { handle } = provider({ grant: granted(["sendTransfer"]), result: { server: "https://v1.example", accepted: false } });
    await assert.rejects(handle(ORIGIN, "sendTransfer", { slot: 24, outputs: OUTPUTS }), (e) => e instanceof SidechainServerError && /didn't accept/.test(e.message));
  });

  test("can be asked for in connect", async () => {
    const { handle } = provider({ grant: granted(["sendTransfer"]) });
    assert.deepEqual(await handle(ORIGIN, "connect", { slots: [24], methods: ["sendTransfer"] }), { slots: [24], methods: ["sendTransfer"] });
  });
});
