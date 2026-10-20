// Which client speaks to a Slot's Sidechain Server: the Server API its Chain Entry names.
import type { ChainEntry, NetworkEntry } from "./chain-module";
import { esploraServer } from "./esplora";
import { SidechainServerError, type Fetch, type SidechainServer } from "./sidechain-server";
import { standardSidechainServer } from "./standard-sidechain-api";

/** A client for `network`'s default Sidechain Server, in the Server API its Chain Entry names. */
export function sidechainServer(entry: ChainEntry, network: NetworkEntry, fetchFn: Fetch = (...args) => fetch(...args)): SidechainServer {
  const { api, url } = network.sidechainServer;
  switch (api) {
    case "ecx-v0":
      return standardSidechainServer(url, fetchFn);
    case "esplora":
      return esploraServer({ url, genesisHash: network.genesisHash, chainName: entry.name }, fetchFn);
    default:
      throw new SidechainServerError(url, `Slot ${entry.slot}'s Chain Entry names a Server API this wallet doesn't speak: ${String(api)}.`);
  }
}
