// The stub Esplora server: the Esplora endpoints the wallet uses (docs/adr/0002), answered from
// fixtures. The e2e build's Sidechain Servers.
//
// Like the Elements explorer it stands in for, it sends no CORS headers: the extension reaches it
// through its `host_permissions`, as it reaches the real one. Dependency-free node `http`.
import { createServer } from "node:http";
import { parseTx, scripthash } from "./bitcoin-tx.mjs";

/**
 * @typedef {{ txid: string, vout: number, value?: number, asset?: string, valuecommitment?: string,
 *   assetcommitment?: string, confirmed: boolean }} UtxoFixture
 * @typedef {{ hex: string, confirmed?: boolean, blockHeight?: number, blockHash?: string }} TxFixture
 * @typedef {{ identityBlock: { height: number, hash: string }, blocks?: Record<number, string>,
 *   tipHeight?: number, utxos?: Record<string, UtxoFixture[]>, addressTxCounts?: Record<string, number>,
 *   txs?: TxFixture[], feeEstimates?: Record<string, number>, refuseBroadcast?: string,
 *   delayMs?: number }} EsploraStubConfig
 */

/**
 * A stub answering from `config`, read on every request (a test may change it between calls):
 * - `GET /block-height/{height}`: `config.identityBlock`'s hash at its height, or `config.blocks`'
 *   (any other height is past the tip: 404); `GET /blocks/tip/height`: `config.tipHeight`;
 * - `GET /address/{address}/utxo`: `config.utxos[address]` (none if absent), each as Esplora shows
 *   it: explicit (`value`, `asset`) or confidential (commitments), with its `status`;
 *   `GET /address/{address}`: its `tx_count` (`config.addressTxCounts`, else its listed outputs);
 * - from the raw transactions in `config.txs` (confirmed or in the mempool), as an indexer would:
 *   `GET /scripthash/{sha256}/utxo` (outputs no listed transaction spends), `GET /tx/{txid}`
 *   (with each input's `prevout`, when its transaction is listed), `/tx/{txid}/hex` and
 *   `/tx/{txid}/status`;
 * - `GET /fee-estimates`: `config.feeEstimates` (404 if absent);
 * - `POST /tx`: parses the transaction, adds it to `config.txs` unconfirmed and answers its txid,
 *   or refuses with `config.refuseBroadcast`.
 * Every answer waits `config.delayMs` (default none), as a slow public server does.
 */
export function createEsploraStub(config) {
  /** Every request, in order: its path, or `POST <path>`. */
  const requests = [];
  /** Every transaction broadcast, hex. */
  const broadcasts = [];

  const status = ({ confirmed = true, blockHeight = 1, blockHash = "00".repeat(32) }) =>
    confirmed ? { confirmed, block_height: blockHeight, block_hash: blockHash, block_time: 1792000000 } : { confirmed };

  /** `config.txs`, parsed, by txid. */
  function indexed() {
    const txs = new Map();
    for (const fixture of config.txs ?? []) txs.set(parseTx(fixture.hex).txid, { ...parseTx(fixture.hex), fixture });
    return txs;
  }

  function txJson(tx, txs) {
    return {
      txid: tx.txid,
      version: tx.version,
      locktime: tx.locktime,
      vin: tx.inputs.map((input) => {
        const prev = txs.get(input.txid)?.outputs[input.vout];
        return {
          txid: input.txid,
          vout: input.vout,
          prevout: prev ? { scriptpubkey: prev.script, value: prev.value } : null,
          scriptsig: input.script,
          witness: input.witness,
          is_coinbase: false,
          sequence: input.sequence,
        };
      }),
      vout: tx.outputs.map((output) => ({ scriptpubkey: output.script, value: output.value })),
      status: status(tx.fixture),
    };
  }

  function route(method, pathname, body) {
    if (method === "POST" && pathname === "/tx") {
      if (config.refuseBroadcast) return [400, config.refuseBroadcast];
      let tx;
      try {
        tx = parseTx(body.trim());
      } catch (error) {
        return [400, `sendrawtransaction RPC error: {"code":-22,"message":"TX decode failed: ${error.message}"}`];
      }
      broadcasts.push(body.trim());
      (config.txs ??= []).push({ hex: body.trim(), confirmed: false });
      return [200, tx.txid];
    }
    if (method !== "GET") return [405, "Method not allowed"];

    const height = /^\/block-height\/([0-9]+)$/.exec(pathname);
    if (height) {
      const { identityBlock, blocks = {} } = config;
      const h = Number(height[1]);
      const hash = h === identityBlock.height ? identityBlock.hash : blocks[h];
      return hash === undefined ? [404, "Block not found"] : [200, hash];
    }
    if (pathname === "/blocks/tip/height") return [200, String(config.tipHeight ?? config.identityBlock.height)];
    if (pathname === "/fee-estimates") return config.feeEstimates ? [200, config.feeEstimates] : [404, "Not found"];

    const utxo = /^\/address\/([^/]+)\/utxo$/.exec(pathname);
    if (utxo) {
      const address = decodeURIComponent(utxo[1]);
      return [200, (config.utxos?.[address] ?? []).map(({ confirmed, ...output }) => ({ ...output, status: status({ confirmed }) }))];
    }
    const address = /^\/address\/([^/]+)$/.exec(pathname);
    if (address) {
      const a = decodeURIComponent(address[1]);
      const count = config.addressTxCounts?.[a] ?? config.utxos?.[a]?.length ?? 0;
      return [200, { address: a, chain_stats: { tx_count: count }, mempool_stats: { tx_count: 0 } }];
    }

    const byScript = /^\/scripthash\/([0-9a-f]{64})\/utxo$/.exec(pathname);
    if (byScript) {
      const txs = indexed();
      const spent = new Set([...txs.values()].flatMap((tx) => tx.inputs.map((i) => `${i.txid}:${i.vout}`)));
      return [
        200,
        [...txs.values()].flatMap((tx) =>
          tx.outputs.flatMap((output, vout) =>
            scripthash(output.script) === byScript[1] && !spent.has(`${tx.txid}:${vout}`)
              ? [{ txid: tx.txid, vout, value: output.value, status: status(tx.fixture) }]
              : [],
          ),
        ),
      ];
    }
    const tx = /^\/tx\/([0-9a-f]{64})(\/hex|\/status)?$/.exec(pathname);
    if (tx) {
      const txs = indexed();
      const found = txs.get(tx[1]);
      if (found === undefined) return [404, "Transaction not found"];
      if (tx[2] === "/hex") return [200, found.fixture.hex];
      if (tx[2] === "/status") return [200, status(found.fixture)];
      return [200, txJson(found, txs)];
    }
    // Esplora's own wording for an unknown endpoint.
    return [404, `endpoint does not exist "${pathname}"`];
  }

  const server = createServer((request, response) => {
    const { pathname } = new URL(request.url, "http://stub");
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      requests.push(request.method === "GET" ? pathname : `${request.method} ${pathname}`);
      const [status, answer] = route(request.method, pathname, body);
      const json = typeof answer !== "string";
      setTimeout(() => {
        response.writeHead(status, { "Content-Type": json ? "application/json" : "text/plain" });
        response.end(json ? JSON.stringify(answer) : answer);
      }, config.delayMs ?? 0);
    });
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
    /** Every request received, in order: its path, or `POST <path>`. */
    requests: () => [...requests],
    /** Every transaction broadcast, hex. */
    broadcasts: () => [...broadcasts],
  };
}
