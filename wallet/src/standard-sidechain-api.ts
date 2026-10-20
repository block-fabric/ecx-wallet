// The wallet's client for the Standard Sidechain API (`ecx-v0`; HTTPS + JSON, paths under `/v1`).
// The protocol is documented next to the stub server, stub-server/README.md. The server knows the
// watch by the id it returns from registration; the client registers before every call (it's
// idempotent, and a server may forget watches), so callers only ever pass watch data.
import { isAssetAmount, serverFetch, SidechainServerError, type Fetch, type SidechainServer, type WatchData } from "./sidechain-server";

export function standardSidechainServer(baseUrl: string, fetchFn: Fetch): SidechainServer {
  const url = baseUrl.replace(/\/+$/, "");

  async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const response = await serverFetch(fetchFn, url, path, {
      method,
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
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

  const malformed = (what: string) => new SidechainServerError(url, `The Sidechain Server at ${url} sent a malformed ${what}.`);

  /** Registers the watch (its descriptor and receive addresses); returns the path of its resources. */
  async function register({ chain, descriptor, receive }: WatchData): Promise<string> {
    const { watchId } = await call<{ watchId?: unknown }>("POST", "/v1/watch", { chain, descriptor, addresses: receive });
    if (typeof watchId !== "string" || watchId === "") throw malformed("registration answer");
    return `/v1/watch/${encodeURIComponent(watchId)}`;
  }

  return {
    url,
    async state(watch) {
      const { balances, history } = await call<{ balances?: unknown; history?: unknown }>("GET", `${await register(watch)}/state`);
      if (!Array.isArray(balances) || !balances.every(isAssetAmount)) throw malformed("state");
      return { balances: balances.map(({ asset, amount }) => ({ asset, amount })), history: Array.isArray(history) ? history : [] };
    },
    buildTransfer: async (watch, order) => call<unknown>("POST", `${await register(watch)}/transfers`, order),
    async submit(watch, requestId, payload) {
      const { accepted, txid } = await call<{ accepted?: unknown; txid?: unknown }>("POST", `${await register(watch)}/submissions`, { requestId, payload });
      return { accepted: accepted === true, ...(typeof txid === "string" ? { txid } : {}) };
    },
  };
}
