// Runs the stub on Slot 24's Chain Entry server URL, answering for the "abandon … about" test
// wallet from the e2e fixtures: `pnpm --filter @ecx/stub-server start`.
import { readFile } from "node:fs/promises";
import { createStubServer } from "./server.mjs";

const root = new URL("../../", import.meta.url);
const entry = JSON.parse(await readFile(new URL("core/elements/chain-entry.json", root), "utf8")).networks.betanet;
const psets = JSON.parse(await readFile(new URL("e2e/fixtures/elements-psets.json", root), "utf8"));

const stub = createStubServer({
  chain: entry.chain,
  state: {
    elements1qew44aehkjstjm56ng2rjrz57vwxh5g9su6dlpm: {
      balances: [{ asset: entry.policyAsset, amount: "150000" }],
      history: [],
    },
  },
  transfers: [
    {
      asset: entry.policyAsset,
      amount: "120000",
      destination: "elements1qepkhlwlq2qjggg89d5quqx8z59vz9mr2h6j4pc",
      payload: psets.clear.payload,
    },
  ],
});
const url = new URL(entry.sidechainServer);
console.log(`stub Sidechain Server for ${entry.chain} at ${await stub.listen(Number(url.port), url.hostname)}`);
