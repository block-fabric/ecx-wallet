// What a Sidechain App can learn about its Grant, and getAddresses while locked (no browser needed).
// The relay of `grantChanged` to pages is tested in the browsers, in manage-grants.test.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { importWallet } from "../harness.mjs";

const { createProviderHandler } = await importWallet();

const ORIGIN = "https://dex.example";
const CHAIN = "ecash:betanet-s24";
const ADDRESSES = [{ chain: CHAIN, address: "elements1q…" }];

/**
 * A Provider handler over fakes: Slot 24 supported and on, the wallet locked unless `unlocked`.
 * Each unlock window is recorded in `windows`; `unlock` answers it (true unlocks the wallet).
 */
function provider({ grant, unlocked = false, unlock = async () => true, isUnlocked } = {}) {
  const state = { unlocked, windows: [] };
  const handle = createProviderHandler({
    grants: {
      get: async (o) => (grant?.origin === o ? grant : undefined),
      put: async () => {},
      remove: async () => {},
      list: async () => (grant ? [grant] : []),
    },
    supportedSlots: [24],
    chainModule: async () => ({ declare: () => ({ binding: { chain: CHAIN } }) }),
    openSigningApproval: (context) => {
      state.windows.push(context);
      return {
        unlock: async () => (state.unlocked = await unlock()),
        confirm: async () => assert.fail("asked to confirm"),
        close() {},
      };
    },
    isUnlocked: isUnlocked ? () => isUnlocked(state) : async () => state.unlocked,
    now: () => Date.now(),
    chains: { isOn: async () => true, turnOn: async () => {} },
    askToConnect: async () => assert.fail("asked to connect"),
    askToTurnOn: async () => assert.fail("asked to turn a chain on"),
    receiveAddresses: async () => ADDRESSES,
    send: async () => assert.fail("sent"),
  });
  return { handle, state };
}

const granted = (extra = {}) => ({ origin: ORIGIN, slots: [24], methods: ["getAddresses"], blindSigning: false, ...extra });

describe("getGrant", () => {
  test("is null for an origin with no Grant", async () => {
    assert.equal(await provider().handle(ORIGIN, "getGrant"), null);
  });

  test("is the caller's scope and whether the wallet is unlocked, with Blind Signing only when opted in", async () => {
    assert.deepEqual(await provider({ grant: granted() }).handle(ORIGIN, "getGrant"), { slots: [24], methods: ["getAddresses"], unlocked: false });
    assert.deepEqual(await provider({ grant: granted({ blindSigning: true }), unlocked: true }).handle(ORIGIN, "getGrant"), {
      slots: [24],
      methods: ["getAddresses"],
      blindSigning: true,
      unlocked: true,
    });
  });

  test("opens no window", async () => {
    const { handle, state } = provider({ grant: granted() });
    await handle(ORIGIN, "getGrant");
    assert.deepEqual(state.windows, []);
  });
});

describe("getAddresses while locked", () => {
  test("asks to unlock in a window naming the app and the chain, then answers", async () => {
    const { handle, state } = provider({ grant: granted() });
    assert.deepEqual(await handle(ORIGIN, "getAddresses", { slot: 24 }), ADDRESSES);
    assert.deepEqual(state.windows, [{ origin: ORIGIN, chain: CHAIN }]);
  });

  test("closing the window is 4001", async () => {
    const { handle } = provider({ grant: granted(), unlock: async () => false });
    await assert.rejects(handle(ORIGIN, "getAddresses", { slot: 24 }), (e) => e.code === 4001);
  });

  test("calls from one origin while its window is open share it", async () => {
    let open;
    const answered = new Promise((resolve) => (open = resolve));
    const { handle, state } = provider({ grant: granted(), unlock: () => answered });
    const both = Promise.all([handle(ORIGIN, "getAddresses", { slot: 24 }), handle(ORIGIN, "getAddresses", { slot: 24 })]);
    await new Promise((r) => setTimeout(r, 10));
    open(true);
    assert.deepEqual(await both, [ADDRESSES, ADDRESSES]);
    assert.equal(state.windows.length, 1);
  });

  test("a call that saw it locked just before another's window unlocked it opens no window of its own", async () => {
    let calls = 0;
    let late;
    const lateAnswer = new Promise((resolve) => (late = resolve));
    // The second call's check answers "locked", but only after the first call's window is done.
    const { handle, state } = provider({ grant: granted(), isUnlocked: async (s) => (++calls === 2 ? lateAnswer : s.unlocked) });
    const first = handle(ORIGIN, "getAddresses", { slot: 24 });
    const second = handle(ORIGIN, "getAddresses", { slot: 24 });
    await first;
    late(false);
    assert.deepEqual(await second, ADDRESSES);
    assert.equal(state.windows.length, 1);
  });

  test("an origin without a Grant gets 4100 and no window", async () => {
    const { handle, state } = provider();
    await assert.rejects(handle(ORIGIN, "getAddresses", { slot: 24 }), (e) => e.code === 4100);
    assert.deepEqual(state.windows, []);
  });
});
