// The pull path's seam to a Slot's Sidechain Server, whichever Server API its Chain Entry names
// (docs/adr/0002): the Standard Sidechain API (standard-sidechain-api.ts) or Esplora (esplora.ts);
// server-api.ts picks the client.
// Everything a server answers is *reported*: the wallet shows balances labelled as such, and treats
// a built transfer as an untrusted Signing Request (parsed, validated and decoded like any other).
import type { AssetAmount, DerivedAddress } from "./chain-module";

/** What the wallet watches: watch data from the Chain Module (never spend authority). */
export interface WatchData {
  chain: string;
  descriptor: string;
  receive: DerivedAddress[];
  change: DerivedAddress[];
}

/** A server's account of a watch. Unverified by the wallet. */
export interface ReportedState {
  balances: AssetAmount[];
  history: unknown[];
}

export interface TransferOrder {
  /** Hex asset id. */
  asset: string;
  /** Base units, as a decimal string. */
  amount: string;
  /** In the chain's own address encoding. */
  destination: string;
}

/** The server couldn't be reached or refused a call. */
export class SidechainServerError extends Error {
  constructor(
    readonly server: string,
    message: string,
    /** The server's error code, when it gave one. */
    readonly code?: string,
  ) {
    super(message);
    this.name = "SidechainServerError";
  }
}

export interface SidechainServer {
  /** The server's base URL: who the wallet names as the requester of what it builds. */
  readonly url: string;
  state(watch: WatchData): Promise<ReportedState>;
  /** Asks the server to build a transfer; returns its Signing Request (unvalidated). */
  buildTransfer(watch: WatchData, order: TransferOrder): Promise<unknown>;
  /** Hands the signed payload back for the server to finalize and broadcast. */
  submit(watch: WatchData, requestId: string, payload: string): Promise<{ accepted: boolean; txid?: string }>;
}

export type Fetch = typeof fetch;

/** `fetch` for a server call: never sends credentials or reads a cache; unreachable → SidechainServerError. */
export async function serverFetch(fetchFn: Fetch, url: string, path: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetchFn(`${url}${path}`, { ...init, credentials: "omit", cache: "no-store" });
  } catch {
    throw new SidechainServerError(url, `Couldn't reach the Sidechain Server at ${url}.`);
  }
}

export function isAssetAmount(a: unknown): a is AssetAmount {
  const { asset, amount } = (a ?? {}) as Record<string, unknown>;
  return typeof asset === "string" && /^[0-9a-f]{64}$/.test(asset) && typeof amount === "string" && /^[0-9]+$/.test(amount);
}
