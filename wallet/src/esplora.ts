// The wallet's client for a Sidechain Server that speaks Esplora (docs/adr/0002): the REST API of
// Blockstream's electrs, limited to the endpoints mempool's electrs fork also serves. Esplora knows
// nothing of watches: the wallet asks for each watched address's outputs and adds them up itself.
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

export function esploraServer({ url: baseUrl, identityBlock, chainName }: EsploraServerConfig, fetchFn: Fetch): SidechainServer {
  const url = baseUrl.replace(/\/+$/, "");
  const malformed = (what: string) => new SidechainServerError(url, `The Sidechain Server at ${url} sent a malformed ${what}.`);

  /** A GET's response; any 2xx is an answer (mempool's instances send 203). */
  async function response(path: string): Promise<{ status: number; ok: boolean; body: string }> {
    const answer = await serverFetch(fetchFn, url, path);
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

  /**
   * The identity check: Esplora has no `info`, but the block at the identity height proves which
   * chain it's on. For a fork (eCash), that's the first block after it: a server for the chain it
   * forked from, or for a later fork of it, has another block there.
   */
  async function checkChain(): Promise<void> {
    const { height, hash: expected } = identityBlock;
    const answer = await response(`/block-height/${height}`);
    // Esplora answers 404 for a height past its tip.
    if (answer.status === 404 && height > 0) {
      throw new SidechainServerError(url, `The Sidechain Server at ${url} hasn't synced to block ${height}, so it can't show it's on ${chainName}.`);
    }
    if (!answer.ok) throw refused(answer);
    const hash = answer.body.trim();
    if (!/^[0-9a-f]{64}$/.test(hash)) throw malformed("block hash");
    if (hash !== expected) {
      const which = height === 0 ? "genesis block" : `block ${height}`;
      throw new SidechainServerError(url, `The Sidechain Server at ${url} is on another chain: its ${which} is ${hash}, not ${chainName}'s ${expected}.`);
    }
  }

  /**
   * The address's confirmed explicit outputs. Confidential ones (commitments, no `value`) aren't
   * counted.
   */
  async function confirmedOutputs(address: string): Promise<AssetAmount[]> {
    let utxos: unknown;
    try {
      utxos = JSON.parse(await get(`/address/${encodeURIComponent(address)}/utxo`));
    } catch (error) {
      if (error instanceof SidechainServerError) throw error;
      throw malformed("list of outputs");
    }
    if (!Array.isArray(utxos)) throw malformed("list of outputs");
    return utxos.flatMap((utxo: { value?: unknown; asset?: unknown; status?: { confirmed?: unknown } }) => {
      if (typeof utxo?.status?.confirmed !== "boolean") throw malformed("output");
      const { value, asset } = utxo;
      if (!utxo.status.confirmed || value === undefined) return [];
      if (!Number.isSafeInteger(value) || (value as number) < 0) throw malformed("output");
      // Bitcoin's Esplora (eCash) has no assets: its outputs carry none, and count as the chain's coin.
      if (asset === undefined) return [{ asset: NATIVE_COIN, amount: String(value) }];
      if (typeof asset !== "string" || !/^[0-9a-f]{64}$/.test(asset)) throw malformed("output");
      return [{ asset, amount: String(value) }];
    });
  }

  const notYet = () => new SidechainServerError(url, `Sending on ${chainName} isn't available yet.`);

  return {
    url,
    async state({ receive, change }) {
      await checkChain();
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
