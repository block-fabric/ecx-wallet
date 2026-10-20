// Runs a stub on the e2e build's Slot 24 Sidechain Server URL (e2e/scripts/build.mjs), answering
// for the "abandon … about" test wallet from the e2e fixtures:
//
//   pnpm --filter @ecx/stub-server start             the Esplora stub, which the e2e build speaks to
//   pnpm --filter @ecx/stub-server start -- ecx-v0   the Standard Sidechain API stub, on the same URL
import { readFile } from "node:fs/promises";
import { E2E_SIDECHAIN_SERVER } from "../../e2e/scripts/build.mjs";
import { createEsploraStub } from "./esplora.mjs";
import { createStubServer } from "./server.mjs";

const root = new URL("../../", import.meta.url);
const entry = JSON.parse(await readFile(new URL("core/elements/chain-entry.json", root), "utf8")).networks.betanet;
const { policyAsset } = entry.params;
const psets = JSON.parse(await readFile(new URL("e2e/fixtures/elements-psets.json", root), "utf8"));
const ADDRESS = "elements1qew44aehkjstjm56ng2rjrz57vwxh5g9su6dlpm";

const api = process.argv[2] ?? "esplora";
const stub =
  api === "esplora"
    ? createEsploraStub({
        identityBlock: entry.identityBlock,
        utxos: { [ADDRESS]: [{ txid: "aa".repeat(32), vout: 0, value: 150000, asset: policyAsset, confirmed: true }] },
      })
    : api === "ecx-v0"
      ? createStubServer({
          chain: entry.chain,
          state: { [ADDRESS]: { balances: [{ asset: policyAsset, amount: "150000" }], history: [] } },
          transfers: [
            {
              asset: policyAsset,
              amount: "120000",
              destination: "elements1qepkhlwlq2qjggg89d5quqx8z59vz9mr2h6j4pc",
              payload: psets.clear.payload,
            },
          ],
        })
      : undefined;
if (stub === undefined) throw new Error(`Unknown Server API ${api}: esplora or ecx-v0.`);
const url = new URL(E2E_SIDECHAIN_SERVER.url);
console.log(`stub ${api} Sidechain Server for ${entry.chain} at ${await stub.listen(Number(url.port), url.hostname)}`);
