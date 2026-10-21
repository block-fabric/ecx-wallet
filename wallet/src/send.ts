// The wallet's own Send (#28, docs/adr/0006). Over Esplora the wallet does what a `/v1` server
// would: it gathers the account's spendable coins, the Slot's Chain Module builds the transfer
// (`buildTransfer`), the module's Decoder explains it in the normal approval window, and only then
// is it signed, finalized and broadcast. A Slot whose server speaks the Standard Sidechain API has
// the server build it instead (pull-path.ts).
//
// Coins a broadcast Send spent are held back from later ones until it confirms, or until the server
// has forgotten it for HOLD_BLOCKS blocks: the server may not list the spend in its mempool yet.
import { canSend, createKeyRouting, type ChainModules, type KeyedChain, type Keys } from "./accounts";
import { cacheKey, type SessionCache } from "./cache";
import { ChainModuleRefusal, type AssetAmount, type ChainEntry, type ClearView, type ModuleTransferOrder, type NetworkEntry, type Starter, type TransferOutput } from "./chain-module";
import { ErrorCode, ProviderRpcError } from "./errors";
import { feeRate, QUERIES_AT_ONCE, type EsploraClient } from "./esplora";
import { checkedOrder, WATCHED_CHANGE_ADDRESSES, WATCHED_RECEIVE_ADDRESSES, type PullPath, type SendResult } from "./pull-path";
import { rejected, type SignPrompt, type SigningApproval } from "./signing";
import { SidechainServerError, type TransferOrder } from "./sidechain-server";

/** Blocks past its broadcast after which a Send the server doesn't know releases its coins. */
export const HOLD_BLOCKS = 6;

/** Who the approval window names for a Send over Esplora: the wallet itself built it. */
export const sendRequester = (chainName: string) => `This wallet (Send on ${chainName})`;

/** The coins a broadcast Send spent, held back from later Sends. */
export interface HeldSpend {
  slot: number;
  txid: string;
  spent: { txid: string; vout: number }[];
  /** The server's tip when it was broadcast. */
  tipHeight: number;
}

/** Where held spends are kept (`storage.local`): they must outlive the session. */
export interface HeldStore {
  list(): Promise<HeldSpend[]>;
  put(held: HeldSpend): Promise<void>;
  remove(txid: string): Promise<void>;
}

export interface SendDeps extends Keys, ChainModules {
  /** The Slot's reads and its `/v1` Send. */
  pullPath: PullPath;
  /** A client for `network`'s default server, when it speaks Esplora. */
  esplora(entry: ChainEntry, network: NetworkEntry): EsploraClient;
  openSigningApproval(context: { origin: string; chain: string }): SigningApproval;
  isUnlocked(): Promise<boolean>;
  held: HeldStore;
  /** Where the Slot's last Send refused after approval is kept for the session. */
  cache?: SessionCache;
  /** Milliseconds since the epoch. */
  now(): number;
}

/**
 * A Send that failed after the user approved it: nothing was sent. The page that asked may be gone
 * by then (the toolbar popup closes when the approval window opens), so the Activity feed shows it.
 */
export interface RefusedSend {
  slot: number;
  outputs: TransferOutput[];
  /** Why, as the user would have read it on the Send screen. */
  reason: string;
  /** Milliseconds since the epoch. */
  at: number;
}

/** A refusal the user reads where they asked for the Send. */
const refusal = (message: string) => new ProviderRpcError(ErrorCode.InvalidParams, message);

/**
 * Checks the Clear View is the transfer that was asked for: the payments first, in order, then
 * only outputs back to the wallet. Anything else is a wallet bug: refused, never shown.
 */
function checkView(view: ClearView, order: TransferOrder): void {
  const paid = view.outputs.slice(0, order.outputs.length);
  const matches = order.outputs.every(({ asset, amount, to }, i) => {
    const out = paid[i];
    return out?.asset === asset && out.amount === amount && out.destination.kind === "address" && out.destination.address.toLowerCase() === to.address.toLowerCase();
  });
  const rest = view.outputs.slice(order.outputs.length).every((o) => o.destination.kind === "address" && o.destination.yours);
  if (!matches || !rest) throw new Error("The built transfer isn't the one asked for.");
}

export function createSends(deps: SendDeps) {
  const routing = createKeyRouting(deps);

  function esplora(target: KeyedChain<Starter>): EsploraClient | undefined {
    const { api } = target.network.sidechainServer;
    if (api !== "esplora") return undefined;
    if (!canSend(target.module.declare().capabilities, target.network)) {
      throw refusal(`This wallet can't send on ${target.entry.name}: its Chain Module doesn't build transfers.`);
    }
    return deps.esplora(target.entry, target.network);
  }

  /** The Slot's held outpoints, after releasing those whose Send confirmed or was forgotten long enough. */
  async function heldOutpoints(slot: number, server: EsploraClient): Promise<Set<string>> {
    const held = new Set<string>();
    let tip: Promise<number> | undefined;
    for (const spend of (await deps.held.list()).filter((h) => h.slot === slot)) {
      const status = await server.txStatus(spend.txid);
      const forgotten = status === undefined && (await (tip ??= server.tipHeight())) >= spend.tipHeight + HOLD_BLOCKS;
      if (status?.confirmed || forgotten) {
        await deps.held.remove(spend.txid);
        continue;
      }
      for (const { txid, vout } of spend.spent) held.add(`${txid}:${vout}`);
    }
    return held;
  }

  /**
   * The account's spendable coins: explicit, confirmed or from a trusted transaction (unless the
   * history may have left some out), and not held back.
   */
  async function spendableCoins(slot: number, target: KeyedChain<Starter>, server: EsploraClient, key: Starter) {
    const account = target.module.deriveAccount(key, { receive: WATCHED_RECEIVE_ADDRESSES, change: WATCHED_CHANGE_ADDRESSES });
    const addresses = [...account.receive.map((a) => ({ ...a, chain: 0 as const })), ...account.change.map((a) => ({ ...a, chain: 1 as const }))];
    const found = [];
    for (let i = 0; i < addresses.length; i += QUERIES_AT_ONCE) {
      found.push(
        ...(await Promise.all(
          addresses.slice(i, i + QUERIES_AT_ONCE).map(async ({ address, chain, index }) =>
            (await server.addressUtxos(address)).flatMap((u) =>
              u.value === undefined || u.asset === undefined ? [] : [{ txid: u.txid, vout: u.vout, asset: u.asset, value: String(u.value), chain, index, confirmed: u.confirmed }],
            ),
          ),
        )),
      );
    }
    const utxos = found.flat();
    const trusted = new Set<string>();
    if (utxos.some((u) => !u.confirmed)) {
      const history = await deps.pullPath.history(slot);
      if (!history.partial) for (const e of history.entries) if (!e.confirmed && e.trusted) trusted.add(e.txid);
    }
    const held = await heldOutpoints(slot, server);
    const coins = utxos
      .filter((u) => (u.confirmed || trusted.has(u.txid)) && !held.has(`${u.txid}:${u.vout}`))
      .map(({ confirmed: _, ...coin }) => coin);
    return { coins, account };
  }

  /** The first change address nothing has paid yet; the last one once all are used. */
  async function changeIndex(server: EsploraClient, change: { address: string; index: number }[]): Promise<number> {
    const counts = await Promise.all(change.map(({ address }) => server.addressTxCount(address)));
    const unused = change.find((_, i) => counts[i] === 0);
    return (unused ?? change[change.length - 1]).index;
  }

  /** A module refusal, as the user reads it. */
  async function refusing<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof ChainModuleRefusal) throw refusal(error.message);
      throw error;
    }
  }

  return {
    /** Per asset, what a Send on the Slot can spend now: over Esplora confirmed plus trusted, less held; else the reported balance. */
    async spendable(slot: number): Promise<AssetAmount[]> {
      const target = await routing.slot(slot);
      const server = esplora(target);
      if (server === undefined) return (await deps.pullPath.reportedState(slot)).balances;
      await server.checkChain();
      const { coins } = await spendableCoins(slot, target, server, await target.key());
      const totals = new Map<string, bigint>();
      for (const { asset, value } of coins) totals.set(asset, (totals.get(asset) ?? 0n) + BigInt(value));
      return [...totals].map(([asset, amount]) => ({ asset, amount: amount.toString() }));
    },

    /** Sends `order` from the Slot. Resolves once broadcast (or accepted by a `/v1` server); throws on refusal or rejection. */
    async send(slot: number, order: TransferOrder): Promise<SendResult> {
      const checked = checkedOrder(order);
      const target = await routing.slot(slot);
      const server = esplora(target);
      if (server === undefined) return deps.pullPath.send(slot, checked);

      await server.checkChain();
      const key = await target.key();
      const [{ coins, account }, estimates, tipHeight] = await Promise.all([
        spendableCoins(slot, target, server, key),
        server.feeEstimates().catch(() => undefined),
        server.tipHeight(),
      ]);
      const moduleOrder: ModuleTransferOrder = {
        coins,
        outputs: checked.outputs,
        feeRate: feeRate(estimates),
        changeIndex: await changeIndex(server, account.change),
      };
      const built = await refusing(async () => target.module.buildTransfer(moduleOrder, key));
      await refusing(async () => target.module.check(built.pset));

      const requester = sendRequester(target.entry.name);
      const approval = deps.openSigningApproval({ origin: requester, chain: target.chain });
      let approved = false;
      try {
        let finalized: { tx: string; txid: string };
        try {
          if (!(await deps.isUnlocked()) && !(await approval.unlock())) throw rejected();
          const decoded = await refusing(async () => target.module.decode(built.pset, await target.key()));
          if (decoded.kind !== "clear") throw new Error(`The wallet can't fully explain the transfer it built: ${decoded.reason}`);
          checkView(decoded.view, checked);
          const prompt: SignPrompt = { origin: requester, chain: target.chain, requestId: `send-${slot}`, decoded };
          if (!(await approval.confirm(prompt))) throw rejected();
          approved = true;
          const signed = await refusing(async () => target.module.sign(built.pset, await target.key()));
          finalized = await refusing(async () => target.module.finalize(signed));
        } finally {
          approval.close();
        }

        let txid: string;
        try {
          txid = await server.broadcast(finalized.tx);
        } catch (error) {
          if (!(error instanceof SidechainServerError)) throw error;
          throw new SidechainServerError(error.server, `${error.message} Nothing was sent.`);
        }
        if (txid !== finalized.txid) throw new SidechainServerError(server.url, `${server.url} reported txid ${txid} for transaction ${finalized.txid}.`);
        await deps.held.put({ slot, txid, spent: built.spent, tipHeight });
        await deps.cache?.set(cacheKey.sendRefused(slot), null);
        return { server: server.url, accepted: true, txid };
      } catch (error) {
        // By now the page that asked may be gone (a popup closes when the approval window opens).
        if (approved) {
          const reason = error instanceof ProviderRpcError || error instanceof SidechainServerError ? error.message : "Internal wallet error.";
          await deps.cache?.set(cacheKey.sendRefused(slot), { slot, outputs: checked.outputs, reason, at: deps.now() } satisfies RefusedSend);
        }
        throw error;
      }
    },

    /** The Slot's last Send refused after approval this session, if not closed since. */
    refused: async (slot: number): Promise<RefusedSend | undefined> => (await deps.cache?.get<RefusedSend | null>(cacheKey.sendRefused(slot))) ?? undefined,

    /** Forgets the Slot's refused Send. */
    dismissRefused: (slot: number) => deps.cache?.set(cacheKey.sendRefused(slot), null) ?? Promise.resolve(),
  };
}

export type Sends = ReturnType<typeof createSends>;
