// Which client speaks to a chain's Sidechain Server: the Server API its Chain Entry names.
import type { SessionCache } from "./cache";
import type { ChainEntry, NetworkEntry } from "./chain-module";
import { esploraServer } from "./esplora";
import { SidechainServerError, type Fetch, type SidechainServer } from "./sidechain-server";
import { standardSidechainServer } from "./standard-sidechain-api";

/** A client for `network`'s default Sidechain Server, in the Server API its Chain Entry names. */
export function sidechainServer(
  entry: ChainEntry,
  network: NetworkEntry,
  fetchFn: Fetch = (...args) => fetch(...args),
  cache?: SessionCache,
): SidechainServer {
  const { api, url } = network.sidechainServer;
  switch (api) {
    case "ecx-v0":
      return standardSidechainServer(url, fetchFn);
    case "esplora":
      return esploraServer({ url, identityBlock: network.identityBlock, chainName: entry.name, cache }, fetchFn);
    default:
      throw new SidechainServerError(url, `${entry.name}'s Chain Entry names a Server API this wallet doesn't speak: ${String(api)}.`);
  }
}
