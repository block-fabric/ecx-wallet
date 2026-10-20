// What the wallet keeps for the session to answer faster. Every entry lives in `storage.session`
// (memory only, gone when the browser closes) and is forgotten on lock (the background clears
// every key under CACHE_PREFIX). Nothing a transaction is built from comes from it, except raw
// transactions, which are checked against their txid before they're kept.
import type { IdentityBlock } from "./chain-module";
import type { KeyValueStore } from "./vault";

export const CACHE_PREFIX = "cache:";

export type SessionCache = Pick<KeyValueStore, "get" | "set">;

export const cacheKey = {
  /** A server that passed the identity check for this block (ADR 0002: once per URL). */
  identity: (url: string, { height, hash }: IdentityBlock) => `${CACHE_PREFIX}identity:${url}:${height}:${hash}`,
  /** The last balance a chain's server reported, for display while it refreshes. */
  balance: (chain: string, url: string) => `${CACHE_PREFIX}balance:${chain}:${url}`,
  /** A raw transaction (hex): it never changes. */
  tx: (txid: string) => `${CACHE_PREFIX}tx:${txid}`,
};
