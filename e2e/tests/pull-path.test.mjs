// Seam 1, pull path: the wallet talks to Slot 24's Sidechain Server (the stub, listening at the
// Chain Entry's `sidechainServer` URL). It registers the addresses it derived, shows the balance
// the server reports, and sends from its own Send screen: the server builds the transfer, the user
// approves it in the approval window, the wallet signs and submits it.
//
// The wallet imports "abandon … about"; its Slot 24 address is a fixed vector (receive-address.test).
// Payloads are the fixture PSETs from core/elements/tests/fixtures.rs (see clear-signing.test).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { BROWSERS, ROOT, launchWallet, openWalletPage, serveSidechainServer, setUpWallet } from "../harness.mjs";

const PSETS = JSON.parse(await readFile(path.join(ROOT, "e2e", "fixtures", "elements-psets.json"), "utf8"));
const CHAIN = "ecash:betanet-s24";
const SLOT_24_ADDRESS = "elements1qew44aehkjstjm56ng2rjrz57vwxh5g9su6dlpm";
const POLICY_ASSET = "5836dcc06130dcf6a65b6ac493813fd65559955283e44cc3f07966294eccb2c8";
const OTHER_ASSET = "1111111111111111111111111111111111111111111111111111111111111111";
// The `clear` fixture pays this foreign address 120 000 and sends 29 000 change back to us.
const FOREIGN_ADDRESS = "elements1qepkhlwlq2qjggg89d5quqx8z59vz9mr2h6j4pc";

/** What the stub reports for the wallet's address, and the transfers it knows how to build. */
const STUB = {
  state: {
    [SLOT_24_ADDRESS]: {
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
};

async function openHome(session) {
  const page = await session.openPage("index.html#/");
  await page.waitForSelector("[data-wallet-ready]", { timeout: 10_000 });
  return page;
}

/** The account screen's reported balances, as a user reads them. */
function readBalances(page) {
  return page.evaluate(() => {
    const text = (e) => e?.textContent.replace(/\s+/g, " ").trim();
    return {
      label: text(document.querySelector("[data-reported-by]")),
      balances: [...document.querySelectorAll("[data-balance]")].map((e) => ({
        asset: e.getAttribute("data-asset"),
        text: text(e),
      })),
    };
  });
}

/** Fills in the Send screen and submits it; returns the page. */
async function startSend(session, { asset = POLICY_ASSET, amount, destination = FOREIGN_ADDRESS }) {
  const page = await openWalletPage(session, "#/send/24");
  await page.waitForSelector(`[data-send-asset] option[value="${asset}"]`, { timeout: 20_000 });
  await page.select("[data-send-asset]", asset);
  await page.type("[data-send-amount]", amount);
  await page.type("[data-send-destination]", destination);
  await page.click("[data-send-submit]");
  return page;
}

/** What the Send screen says once the send is over. */
async function sendOutcome(page) {
  await page.waitForSelector("[data-send-done], [data-error]", { timeout: 20_000 });
  return page.evaluate(() => ({
    done: document.querySelector("[data-send-done]")?.textContent.replace(/\s+/g, " ").trim(),
    error: document.querySelector("[data-error]")?.textContent.replace(/\s+/g, " ").trim(),
  }));
}

for (const browserName of BROWSERS) describe(browserName, () => {
  let session;
  let stub;
  before(async () => {
    [session, stub] = await Promise.all([launchWallet(browserName), serveSidechainServer(STUB)]);
    await setUpWallet(session); // ABANDON, no passphrase
  });
  after(async () => {
    await session?.close();
    await stub?.close();
  });

  test("the account screen registers the wallet's addresses and shows each asset's balance, labelled as reported by the server", async () => {
    const page = await openHome(session);
    await page.waitForSelector("[data-balance]", { timeout: 20_000 });
    const shown = await readBalances(page);

    const [registration] = stub.registrations();
    assert.equal(registration.chain, CHAIN);
    assert.ok(registration.addresses.some((a) => a.address === SLOT_24_ADDRESS), "the wallet registered the address it derived");
    assert.match(registration.descriptor, /^elwpkh\(\[[0-9a-f]{8}\/84h\/1h\/0h\]tpub/);

    assert.match(shown.label, new RegExp(`Reported by ${stub.url.replace(/[.]/g, "\\.")}`));
    assert.deepEqual(shown.balances.map((b) => b.asset), [POLICY_ASSET, OTHER_ASSET]);
    assert.match(shown.balances[0].text, /150000/);
    assert.match(shown.balances[1].text, /\b7\b/);
    await page.close();
  });

  test("Send: the server builds the transfer, the approval window Clear-Signs it naming the server, and the wallet submits the signed payload", async () => {
    const page = await startSend(session, { amount: "120000" });
    const approval = await session.waitForApprovalWindow();
    const shown = await approval.evaluate(() => ({
      clearView: document.querySelector("[data-clear-view]") !== null,
      origin: document.querySelector("[data-origin]")?.textContent.trim(),
      chain: document.querySelector("[data-chain]")?.textContent.trim(),
      outputs: [...document.querySelectorAll("[data-output] [data-destination]")].map((e) => e.textContent.trim()),
    }));
    assert.equal(shown.clearView, true);
    assert.equal(shown.origin, stub.url, "the Sidechain Server is named as the requester");
    assert.equal(shown.chain, CHAIN);
    assert.equal(shown.outputs[0], FOREIGN_ADDRESS);
    assert.deepEqual(stub.submissions(), [], "nothing is submitted before approval");

    await approval.click("[data-approve]");
    const outcome = await sendOutcome(page);
    assert.match(outcome.done ?? "", /submitted/i);
    const submissions = stub.submissions();
    assert.equal(submissions.length, 1);
    assert.equal(submissions[0].payload, PSETS.clear.signed, "the same PSET, signed on our input only");
    await page.close();
  });

  test("Send: rejecting in the approval window submits nothing", async () => {
    const before = stub.submissions().length;
    const page = await startSend(session, { amount: "120000" });
    await (await session.waitForApprovalWindow()).click("[data-reject]");
    const outcome = await sendOutcome(page);
    assert.equal(outcome.done, undefined);
    assert.match(outcome.error, /rejected/i);
    assert.equal(stub.submissions().length, before);
    await page.close();
  });

  test("Send: a server-built request the Decoder can't fully explain is refused, never Blind-signed", async () => {
    const before = stub.submissions().length;
    const page = await startSend(session, { amount: "2" });
    const outcome = await sendOutcome(page);
    assert.equal(outcome.done, undefined);
    assert.match(outcome.error, /Clear Signed/);
    assert.equal((await session.approvalWindows()).length, 0, "no approval window, so no way to Blind-sign it");
    assert.equal(stub.submissions().length, before);
    await page.close();
  });

  for (const [what, amount, message] of [
    ["a wrong genesis", "3", /genesis/i],
    ["an expired expiresAt", "4", /expired/i],
    ["a confidential input", "5", /confidential/i],
    ["a confidential output", "6", /confidential/i],
  ]) {
    test(`Send: a server-built request with ${what} is refused`, async () => {
      const before = stub.submissions().length;
      const page = await startSend(session, { amount });
      const outcome = await sendOutcome(page);
      assert.equal(outcome.done, undefined);
      assert.match(outcome.error, message);
      assert.equal((await session.approvalWindows()).length, 0);
      assert.equal(stub.submissions().length, before);
      await page.close();
    });
  }

  test("none of the above raised extension runtime errors", async () => {
    assert.deepEqual((await session.extensionErrors()).runtimeErrors, []);
  });
});
