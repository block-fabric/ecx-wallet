// The wallet's client for the standard Sidechain Server API, pull side (HTTPS + JSON). The protocol
// is documented next to the stub server, stub-server/README.md. Everything a server answers is
// *reported*: the wallet shows balances labelled as such, and treats a built transfer as an
// untrusted Signing Request (parsed, validated and decoded like any other).
import type { AssetAmount, DerivedAddress } from "./chain-module";

/** What the wallet registers: watch data from the Chain Module (never spend authority). */
export interface WatchData {
  chain: string;
  descriptor: string;
  addresses: DerivedAddress[];
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
  /** Registers watch data; returns the server's id for it. Idempotent. */
  register(watch: WatchData): Promise<string>;
  state(watchId: string): Promise<ReportedState>;
  /** Asks the server to build a transfer; returns its Signing Request (unvalidated). */
  buildTransfer(watchId: string, order: TransferOrder): Promise<unknown>;
  /** Hands the signed payload back for the server to finalize and broadcast. */
  submit(watchId: string, requestId: string, payload: string): Promise<{ accepted: boolean; txid?: string }>;
}

export function sidechainServer(baseUrl: string, fetchFn: typeof fetch = (...args) => fetch(...args)): SidechainServer {
  const url = baseUrl.replace(/\/+$/, "");

  async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetchFn(`${url}${path}`, {
        method,
        ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
        credentials: "omit",
        cache: "no-store",
      });
    } catch {
      throw new SidechainServerError(url, `Couldn't reach the Sidechain Server at ${url}.`);
    }
    let answer: unknown;
    try {
      answer = await response.json();
    } catch {
      throw new SidechainServerError(url, `The Sidechain Server at ${url} sent an answer that isn't JSON.`);
    }
    if (!response.ok) {
      const error = (answer as { error?: { code?: unknown; message?: unknown } })?.error;
      const message = typeof error?.message === "string" ? error.message : `HTTP ${response.status}`;
      throw new SidechainServerError(url, `The Sidechain Server at ${url} refused: ${message}`, typeof error?.code === "string" ? error.code : undefined);
    }
    return answer as T;
  }

  const watchPath = (watchId: string) => `/v1/watch/${encodeURIComponent(watchId)}`;
  const malformed = (what: string) => new SidechainServerError(url, `The Sidechain Server at ${url} sent a malformed ${what}.`);

  return {
    url,
    async register(watch) {
      const { watchId } = await call<{ watchId?: unknown }>("POST", "/v1/watch", watch);
      if (typeof watchId !== "string" || watchId === "") throw malformed("registration answer");
      return watchId;
    },
    async state(watchId) {
      const { balances, history } = await call<{ balances?: unknown; history?: unknown }>("GET", `${watchPath(watchId)}/state`);
      if (!Array.isArray(balances) || !balances.every(isAssetAmount)) throw malformed("state");
      return { balances: balances.map(({ asset, amount }) => ({ asset, amount })), history: Array.isArray(history) ? history : [] };
    },
    buildTransfer: (watchId, order) => call<unknown>("POST", `${watchPath(watchId)}/transfers`, order),
    async submit(watchId, requestId, payload) {
      const { accepted, txid } = await call<{ accepted?: unknown; txid?: unknown }>("POST", `${watchPath(watchId)}/submissions`, { requestId, payload });
      return { accepted: accepted === true, ...(typeof txid === "string" ? { txid } : {}) };
    },
  };
}

function isAssetAmount(a: unknown): a is AssetAmount {
  const { asset, amount } = (a ?? {}) as Record<string, unknown>;
  return typeof asset === "string" && /^[0-9a-f]{64}$/.test(asset) && typeof amount === "string" && /^[0-9]+$/.test(amount);
}
