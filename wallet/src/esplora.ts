// The wallet's client for a Sidechain Server that speaks Esplora (docs/adr/0002): the REST API of
// Blockstream's electrs, limited to the endpoints mempool's electrs fork also serves. Esplora knows
// nothing of watches: the wallet asks for each watched address's outputs and adds them up itself.
import type { AssetAmount } from "./chain-module";
import { serverFetch, SidechainServerError, type Fetch, type SidechainServer } from "./sidechain-server";

/** How many address queries run at once (40 addresses per read). */
const QUERIES_AT_ONCE = 8;

export interface EsploraServerConfig {
  url: string;
  /** The network's genesis, display hex: the server must be on this chain. */
  genesisHash: string;
  /** The chain's display name, for messages. */
  chainName: string;
}

export function esploraServer({ url: baseUrl, genesisHash, chainName }: EsploraServerConfig, fetchFn: Fetch): SidechainServer {
  const url = baseUrl.replace(/\/+$/, "");
  const malformed = (what: string) => new SidechainServerError(url, `The Sidechain Server at ${url} sent a malformed ${what}.`);

  /** A GET's body; any 2xx is an answer (mempool's instances send 203). */
  async function get(path: string): Promise<string> {
    const response = await serverFetch(fetchFn, url, path);
    const body = await response.text().catch(() => "");
    if (!response.ok) {
      const reason = body.trim().slice(0, 200) || `HTTP ${response.status}`;
      throw new SidechainServerError(url, `The Sidechain Server at ${url} refused: ${reason}`);
    }
    return body;
  }

  /** The identity check: Esplora has no `info`, but its genesis block proves which chain it's on. */
  async function checkChain(): Promise<void> {
    const hash = (await get("/block-height/0")).trim();
    if (!/^[0-9a-f]{64}$/.test(hash)) throw malformed("genesis block hash");
    if (hash !== genesisHash) {
      throw new SidechainServerError(url, `The Sidechain Server at ${url} is on another chain: its genesis block is ${hash}, not ${chainName}'s ${genesisHash}.`);
    }
  }

  /** The address's confirmed explicit outputs. Confidential ones (commitments, no `value`) aren't counted. */
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
      if (!Number.isSafeInteger(value) || (value as number) < 0 || typeof asset !== "string" || !/^[0-9a-f]{64}$/.test(asset)) {
        throw malformed("output");
      }
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
