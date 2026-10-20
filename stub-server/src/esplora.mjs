// The stub Esplora server: the Esplora endpoints the wallet uses (docs/adr/0002), answered from
// fixtures. The e2e build's Sidechain Servers.
//
// Like the Elements explorer it stands in for, it sends no CORS headers: the extension reaches it
// through its `host_permissions`, as it reaches the real one. Dependency-free node `http`.
import { createServer } from "node:http";

/**
 * @typedef {{ txid: string, vout: number, value?: number, asset?: string, valuecommitment?: string,
 *   assetcommitment?: string, confirmed: boolean }} UtxoFixture
 * @typedef {{ identityBlock: { height: number, hash: string }, utxos?: Record<string, UtxoFixture[]> }} EsploraStubConfig
 */

/**
 * A stub answering from `config`, read on every request (a test may change it between calls):
 * - `GET /block-height/{config.identityBlock.height}`: its `hash`; any other height is past the
 *   tip (404), as on a server that has only synced that far;
 * - `GET /address/{address}/utxo`: `config.utxos[address]` (none if absent), each as Esplora
 *   shows it: explicit (`value`, `asset`) or confidential (commitments), with its `status`.
 */
export function createEsploraStub(config) {
  /** Every request path, in order. */
  const requests = [];

  function route(method, pathname) {
    if (method !== "GET") return [405, "Method not allowed"];
    const height = /^\/block-height\/([0-9]+)$/.exec(pathname);
    if (height) {
      const { identityBlock } = config;
      return Number(height[1]) === identityBlock.height ? [200, identityBlock.hash] : [404, "Block not found"];
    }
    const utxo = /^\/address\/([^/]+)\/utxo$/.exec(pathname);
    if (utxo) {
      const address = decodeURIComponent(utxo[1]);
      return [200, (config.utxos?.[address] ?? []).map(({ confirmed, ...output }) => ({
        ...output,
        status: confirmed ? { confirmed, block_height: 1, block_hash: "00".repeat(32), block_time: 1792000000 } : { confirmed },
      }))];
    }
    // Esplora's own wording for an unknown endpoint.
    return [404, `endpoint does not exist "${pathname}"`];
  }

  const server = createServer((request, response) => {
    const { pathname } = new URL(request.url, "http://stub");
    requests.push(pathname);
    const [status, body] = route(request.method, pathname);
    const json = typeof body !== "string";
    response.writeHead(status, { "Content-Type": json ? "application/json" : "text/plain" });
    response.end(json ? JSON.stringify(body) : body);
  });

  return {
    /** Listens on `host:port`; resolves with the base URL. */
    listen(port = 0, host = "127.0.0.1") {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => resolve(`http://${host}:${server.address().port}`));
      });
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
    /** Every request path received, in order. */
    requests: () => [...requests],
  };
}
