// Which client speaks to a chain's Sidechain Server: the Server API its Chain Entry names.
import type { SessionCache } from "./cache";
import type { ChainEntry, NetworkEntry } from "./chain-module";
import { esploraServer, FLUSH_STALL_SECONDS, type EsploraServerConfig } from "./esplora";
import { SidechainServerError, type Fetch, type SidechainServer } from "./sidechain-server";
import { standardSidechainServer } from "./standard-sidechain-api";

/** How to reach `network`'s default server over Esplora: Flush's (`flush`) also reports finality and can stall (docs/adr/0012). */
export function esploraConfig(entry: ChainEntry, network: NetworkEntry, cache?: SessionCache): EsploraServerConfig {
  const { api, url } = network.sidechainServer;
  const flush = api === "flush" ? { finality: true, stallAfter: FLUSH_STALL_SECONDS } : {};
  return { url, identityBlock: network.identityBlock, chainName: entry.name, cache, ...flush };
}

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
    case "flush":
      return esploraServer(esploraConfig(entry, network, cache), fetchFn);
    default:
      throw new SidechainServerError(url, `${entry.name}'s Chain Entry names a Server API this wallet doesn't speak: ${String(api)}.`);
  }
}
