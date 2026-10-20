// The wallet's client for a Sidechain Server that speaks Esplora (docs/adr/0002): the REST API of
// Blockstream's electrs, limited to the endpoints mempool's electrs fork also serves. Esplora knows
// nothing of watches: the wallet asks for each watched address's outputs and adds them up itself.
//
// `esploraClient` is the API itself, endpoint by endpoint, each answer checked for shape (Deposit
// uses it directly on eCash's server); `esploraServer` is the pull path's view of it.
import { NATIVE_COIN, type AssetAmount, type IdentityBlock } from "./chain-module";
import { serverFetch, SidechainServerError, type Fetch, type SidechainServer } from "./sidechain-server";

/** How many address queries run at once (40 addresses per read). */
const QUERIES_AT_ONCE = 8;

export interface EsploraServerConfig {
  url: string;
  /** The block the server must have: the network's genesis, or for a fork its first block after it. */
  identityBlock: IdentityBlock;
  /** The chain's display name, for messages. */
  chainName: string;
}

/** An unspent output, as Esplora lists it for an address or a script. */
export interface EsploraUtxo {
  txid: string;
  vout: number;
  /** Absent for a confidential output (Elements). */
  value?: number;
  /** Elements only; absent on a chain without assets. */
  asset?: string;
  confirmed: boolean;
}

/** Where a transaction stands. */
export interface EsploraTxStatus {
  confirmed: boolean;
  blockHeight?: number;
  blockHash?: string;
}

/** A transaction as Esplora shows it: what it spends (with the spent outputs' scripts) and pays. */
export interface EsploraTx {
  txid: string;
  vin: { txid: string; vout: number; prevout: { scriptpubkey: string; value: number } | null }[];
  vout: { scriptpubkey: string; value?: number }[];
  status: EsploraTxStatus;
}

export type EsploraClient = ReturnType<typeof esploraClient>;

const HEX = /^[0-9a-f]*$/;
const HASH = /^[0-9a-f]{64}$/;
const isCount = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;

export function esploraClient({ url: baseUrl, identityBlock, chainName }: EsploraServerConfig, fetchFn: Fetch) {
  const url = baseUrl.replace(/\/+$/, "");
  const malformed = (what: string) => new SidechainServerError(url, `The Sidechain Server at ${url} sent a malformed ${what}.`);

  /** A call's response; any 2xx is an answer (mempool's instances send 203). */
  async function response(path: string, init?: RequestInit): Promise<{ status: number; ok: boolean; body: string }> {
    const answer = await serverFetch(fetchFn, url, path, init);
    return { status: answer.status, ok: answer.ok, body: await answer.text().catch(() => "") };
  }

  function refused({ status, body }: { status: number; body: string }): SidechainServerError {
    const reason = body.trim().slice(0, 200) || `HTTP ${status}`;
    return new SidechainServerError(url, `The Sidechain Server at ${url} refused: ${reason}`);
  }

  /** A GET's body. */
  async function get(path: string): Promise<string> {
    const answer = await response(path);
    if (!answer.ok) throw refused(answer);
    return answer.body;
  }

  /** A GET's body as JSON; `what` names it in the error if it isn't. */
  async function getJson(path: string, what: string): Promise<unknown> {
    const body = await get(path);
    try {
      return JSON.parse(body);
    } catch {
      throw malformed(what);
    }
  }

  function status(raw: unknown): EsploraTxStatus {
    const { confirmed, block_height, block_hash } = (raw ?? {}) as Record<string, unknown>;
    if (typeof confirmed !== "boolean") throw malformed("transaction status");
    if (!confirmed) return { confirmed };
    if (!isCount(block_height) || typeof block_hash !== "string" || !HASH.test(block_hash)) throw malformed("transaction status");
    return { confirmed, blockHeight: block_height, blockHash: block_hash };
  }

  function utxos(raw: unknown): EsploraUtxo[] {
    if (!Array.isArray(raw)) throw malformed("list of outputs");
    return raw.map((utxo: Record<string, unknown>) => {
      const { txid, vout, value, asset } = utxo ?? {};
      if (typeof txid !== "string" || !HASH.test(txid) || !isCount(vout)) throw malformed("output");
      if (value !== undefined && !isCount(value)) throw malformed("output");
      if (asset !== undefined && (typeof asset !== "string" || !HASH.test(asset))) throw malformed("output");
      return { txid, vout, ...(value === undefined ? {} : { value }), ...(asset === undefined ? {} : { asset }), confirmed: status(utxo.status).confirmed };
    });
  }

  return {
    url,

    /** The hash of the block at `height`, or undefined if the server hasn't reached it (404). */
    async blockHash(height: number): Promise<string | undefined> {
      const answer = await response(`/block-height/${height}`);
      if (answer.status === 404) return undefined;
      if (!answer.ok) throw refused(answer);
      const hash = answer.body.trim();
      if (!HASH.test(hash)) throw malformed("block hash");
      return hash;
    },

    /**
     * The identity check: Esplora has no `info`, but the block at the identity height proves which
     * chain it's on. For a fork (eCash), that's the first block after it: a server for the chain it
     * forked from, or for a later fork of it, has another block there.
     */
    async checkChain(): Promise<void> {
      const { height, hash: expected } = identityBlock;
      const hash = await this.blockHash(height);
      if (hash === undefined) {
        if (height > 0) {
          throw new SidechainServerError(url, `The Sidechain Server at ${url} hasn't synced to block ${height}, so it can't show it's on ${chainName}.`);
        }
        throw refused({ status: 404, body: "Block not found" });
      }
      if (hash !== expected) {
        const which = height === 0 ? "genesis block" : `block ${height}`;
        throw new SidechainServerError(url, `The Sidechain Server at ${url} is on another chain: its ${which} is ${hash}, not ${chainName}'s ${expected}.`);
      }
    },

    async tipHeight(): Promise<number> {
      const height = Number((await get("/blocks/tip/height")).trim());
      if (!isCount(height)) throw malformed("tip height");
      return height;
    },

    /** The address's unspent outputs, confirmed or not. */
    addressUtxos: async (address: string) => utxos(await getJson(`/address/${encodeURIComponent(address)}/utxo`, "list of outputs")),

    /** The unspent outputs to the script whose SHA-256 is `scripthash` (plain byte order, not Electrum's). */
    scripthashUtxos: async (scripthash: string) => utxos(await getJson(`/scripthash/${scripthash}/utxo`, "list of outputs")),

    /** How many transactions, confirmed or not, involve the address. */
    async addressTxCount(address: string): Promise<number> {
      const stats = (await getJson(`/address/${encodeURIComponent(address)}`, "address")) as Record<string, Record<string, unknown> | undefined>;
      const [chain, mempool] = [stats?.chain_stats?.tx_count, stats?.mempool_stats?.tx_count];
      if (!isCount(chain) || !isCount(mempool)) throw malformed("address");
      return chain + mempool;
    },

    async tx(txid: string): Promise<EsploraTx> {
      const tx = (await getJson(`/tx/${txid}`, "transaction")) as Record<string, unknown>;
      const prevout = (p: unknown) => {
        if (p === null) return null;
        const { scriptpubkey, value } = (p ?? {}) as Record<string, unknown>;
        if (typeof scriptpubkey !== "string" || !HEX.test(scriptpubkey) || !isCount(value)) throw malformed("transaction");
        return { scriptpubkey, value };
      };
      if (tx?.txid !== txid || !Array.isArray(tx.vin) || !Array.isArray(tx.vout)) throw malformed("transaction");
      return {
        txid,
        vin: tx.vin.map((input: Record<string, unknown>) => {
          if (input?.is_coinbase === true) return { txid: "00".repeat(32), vout: 0xffffffff, prevout: null };
          if (typeof input?.txid !== "string" || !HASH.test(input.txid) || !isCount(input.vout)) throw malformed("transaction");
          return { txid: input.txid, vout: input.vout, prevout: prevout(input.prevout) };
        }),
        vout: tx.vout.map((output: Record<string, unknown>) => {
          if (typeof output?.scriptpubkey !== "string" || !HEX.test(output.scriptpubkey)) throw malformed("transaction");
          if (output.value !== undefined && !isCount(output.value)) throw malformed("transaction");
          return { scriptpubkey: output.scriptpubkey, ...(output.value === undefined ? {} : { value: output.value as number }) };
        }),
        status: status(tx.status),
      };
    },

    /** The raw transaction, hex. Whoever uses it checks it hashes to `txid`. */
    async txHex(txid: string): Promise<string> {
      const hex = (await get(`/tx/${txid}/hex`)).trim();
      if (!HEX.test(hex) || hex.length === 0 || hex.length % 2 !== 0) throw malformed("transaction");
      return hex;
    },

    /** Where the transaction stands; undefined if the server doesn't know it (404). */
    async txStatus(txid: string): Promise<EsploraTxStatus | undefined> {
      const answer = await response(`/tx/${txid}/status`);
      if (answer.status === 404) return undefined;
      if (!answer.ok) throw refused(answer);
      try {
        return status(JSON.parse(answer.body));
      } catch (error) {
        if (error instanceof SidechainServerError) throw error;
        throw malformed("transaction status");
      }
    },

    /** Fee rates (sat/vB) by confirmation target in blocks. */
    async feeEstimates(): Promise<Record<string, number>> {
      const estimates = await getJson("/fee-estimates", "fee estimate");
      if (typeof estimates !== "object" || estimates === null || Array.isArray(estimates)) throw malformed("fee estimate");
      const rates = Object.entries(estimates).filter(([target, rate]) => /^[0-9]+$/.test(target) && typeof rate === "number" && rate >= 0);
      return Object.fromEntries(rates) as Record<string, number>;
    },

    /** Broadcasts a raw transaction (hex); returns the txid the server reports. */
    async broadcast(tx: string): Promise<string> {
      const answer = await response("/tx", { method: "POST", body: tx, headers: { "Content-Type": "text/plain" } });
      if (!answer.ok) throw refused(answer);
      const txid = answer.body.trim();
      if (!HASH.test(txid)) throw malformed("txid");
      return txid;
    },
  };
}

export function esploraServer(config: EsploraServerConfig, fetchFn: Fetch): SidechainServer {
  const client = esploraClient(config, fetchFn);
  const { url } = client;

  /**
   * The address's confirmed explicit outputs. Confidential ones (commitments, no `value`) aren't
   * counted. Bitcoin's Esplora (eCash) has no assets: its outputs carry none, and count as the
   * chain's coin.
   */
  async function confirmedOutputs(address: string): Promise<AssetAmount[]> {
    return (await client.addressUtxos(address)).flatMap(({ value, asset, confirmed }) =>
      !confirmed || value === undefined ? [] : [{ asset: asset ?? NATIVE_COIN, amount: String(value) }],
    );
  }

  const notYet = () => new SidechainServerError(url, `Sending on ${config.chainName} isn't available yet.`);

  return {
    url,
    async state({ receive, change }) {
      await client.checkChain();
      const addresses = [...receive, ...change].map((a) => a.address);
      const totals = new Map<string, bigint>();
      for (let i = 0; i < addresses.length; i += QUERIES_AT_ONCE) {
        const outputs = await Promise.all(addresses.slice(i, i + QUERIES_AT_ONCE).map(confirmedOutputs));
        for (const { asset, amount } of outputs.flat()) totals.set(asset, (totals.get(asset) ?? 0n) + BigInt(amount));
      }
      return { balances: [...totals].map(([asset, amount]) => ({ asset, amount: amount.toString() })), history: [] };
    },
    // Building and broadcasting over Esplora come with the Send issue (#28).
    buildTransfer: async () => {
      throw notYet();
    },
    submit: async () => {
      throw notYet();
    },
  };
}
