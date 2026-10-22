// Deposit (#31): moving eCash into a Slot with an M5, the wallet's own L1 transaction.
//
// The Slot's Chain Module says what the Deposit is credited to (`depositDestination`, from its
// Starter); the wallet finds the Slot's Treasury on its own L1 Esplora (treasury.ts); the L1 module
// builds the M5 from the account's confirmed coins, the L1 Decoder explains it in the normal
// approval window, and only then is it signed, finalized and broadcast. Each module only ever gets
// its own key. No Sidechain Server sees the L1 coins.
//
// Afterwards the deposit waits: the Slot's L1 confirmations (6 on betanet), then for someone running the Slot's node to
// import it (crediting isn't automatic on Elements), then it shows on the Slot's server.
import { createKeyRouting, type ChainModules, type Keys } from "./accounts";
import { cacheKey, type SessionCache } from "./cache";
import { ChainModuleRefusal, type ChainEntry, type ClearView, type DepositCredit, type L1AccountKey, type L1Module, type NetworkEntry } from "./chain-module";
import { ErrorCode, ProviderRpcError } from "./errors";
import { feeRate, QUERIES_AT_ONCE, type EsploraClient } from "./esplora";
import { WATCHED_CHANGE_ADDRESSES, WATCHED_RECEIVE_ADDRESSES } from "./pull-path";
import { rejected, type SignPrompt, type SigningApproval } from "./signing";
import { SidechainServerError } from "./sidechain-server";
import { findTreasury, TreasuryError } from "./treasury";

/** L1 confirmations before a Slot credits a Deposit, when its Chain Entry doesn't say: BIP300's. */
export const CONFIRMATIONS_TO_CREDIT = 100;

/** L1 confirmations before the Slot credits a Deposit on this network. */
export const confirmationsToCredit = (network: NetworkEntry) => network.depositConfirmations ?? CONFIRMATIONS_TO_CREDIT;

/** Who the approval window names for a Deposit: the wallet itself asks. */
export const DEPOSIT_REQUESTER = "This wallet (Deposit from the main chain)";

/** A broadcast Deposit the wallet keeps an eye on, until it is credited or the user stops tracking it. */
export interface PendingDeposit {
  slot: number;
  /** The Slot's chain, by name. */
  chainName: string;
  txid: string;
  /** The new Treasury output. */
  vout: number;
  /** Sats, as a decimal string: what the Slot credits. */
  value: string;
  /** Where on the Slot, in its own encoding. */
  address: string;
  /** The asset the credit arrives in. */
  asset: string;
  /** Milliseconds since the epoch. */
  createdAt: number;
}

/** The arguments anyone with the Slot's node can credit the Deposit with (`importdrivechaindeposit`). */
export interface DepositClaim {
  txid: string;
  vout: number;
  blockHash: string;
  address: string;
  value: string;
}

/** Where a pending Deposit stands. Everything but `confirmations` is as the servers report it. */
export type DepositStatus = PendingDeposit &
  (
    | { state: "confirming"; confirmations: number; required: number }
    | { state: "awaitingCredit"; confirmations: number; claim: DepositClaim; creditServer?: string }
    | { state: "credited"; creditServer: string }
    | { state: "notFound"; server: string }
    | { state: "unavailable"; error: string }
  );

/** A Deposit that failed after the user approved it: nothing was sent. */
export interface RefusedDeposit {
  slot: number;
  /** Sats, as a decimal string. */
  value: string;
  /** Why, as the user would have read it on the Deposit screen. */
  reason: string;
  /** Milliseconds since the epoch. */
  at: number;
}

/** Where pending Deposits are kept (`storage.local`). */
export interface DepositStore {
  list(): Promise<PendingDeposit[]>;
  put(deposit: PendingDeposit): Promise<void>;
  remove(txid: string): Promise<void>;
}

export interface DepositDeps extends Keys, ChainModules {
  /** A client for `network`'s default server, which must speak Esplora. */
  esplora(entry: ChainEntry, network: NetworkEntry): EsploraClient;
  /** A window for the approval of one request from `origin` for `chain`. */
  openSigningApproval(context: { origin: string; chain: string }): SigningApproval;
  isUnlocked(): Promise<boolean>;
  store: DepositStore;
  /**
   * Where raw transactions are kept for the session (each checked against its txid first), and
   * the Slot's last Deposit refused after approval.
   */
  cache?: SessionCache;
  /** Milliseconds since the epoch. */
  now(): number;
}

/** A refusal the user reads where they asked for the Deposit. */
const refusal = (message: string) => new ProviderRpcError(ErrorCode.InvalidParams, message);

/**
 * Checks the Clear View is the Deposit that was asked for (one Deposit, to `slot`, of `amount`,
 * credited to `destination`) and adds what the Slot's Chain Module says about its destination.
 * Anything else is a wallet bug: refused, never shown.
 */
function depositView(view: ClearView, slot: number, amount: string, destination: string, credit: DepositCredit): ClearView {
  const deposits = view.outputs.filter((o) => o.destination.kind === "deposit");
  const [only] = deposits;
  if (deposits.length !== 1 || only.destination.kind !== "deposit") throw new Error("The built Deposit doesn't decode as one Deposit.");
  const d = only.destination;
  if (d.slot !== slot || d.deposit !== amount || d.data !== destination) throw new Error("The built Deposit isn't the one asked for.");
  return { ...view, outputs: view.outputs.map((o) => (o === only ? { ...o, destination: { ...d, credit } } : o)) };
}

export function createDeposits(deps: DepositDeps) {
  const routing = createKeyRouting(deps);

  function esplora(target: { entry: ChainEntry; network: NetworkEntry }): EsploraClient {
    if (target.network.sidechainServer.api !== "esplora") {
      throw refusal(`Deposits need ${target.entry.name}'s server to speak Esplora; its Chain Entry names ${target.network.sidechainServer.api}.`);
    }
    return deps.esplora(target.entry, target.network);
  }

  /** A raw transaction, from the session's cache or else the server; kept only once it hashes to `txid`. */
  async function txHex(server: EsploraClient, module: L1Module, txid: string): Promise<string> {
    const key = cacheKey.tx(txid);
    const cached = await deps.cache?.get<string>(key);
    if (cached !== undefined) return cached;
    const tx = await server.txHex(txid);
    let actual: string | undefined;
    try {
      actual = module.txid(tx);
    } catch {
      // Not a transaction: refused below.
    }
    if (actual !== txid) throw new SidechainServerError(server.url, `The Sidechain Server at ${server.url} sent another transaction than ${txid}.`);
    await deps.cache?.set(key, tx);
    return tx;
  }

  /** The account's confirmed coins, each with its whole transaction, and its first unused change index. */
  async function coins(l1: EsploraClient, module: L1Module, key: L1AccountKey) {
    const account = module.deriveAccount(key, { receive: WATCHED_RECEIVE_ADDRESSES, change: WATCHED_CHANGE_ADDRESSES });
    const addresses = [
      ...account.receive.map((a) => ({ ...a, chain: 0 as const })),
      ...account.change.map((a) => ({ ...a, chain: 1 as const })),
    ];
    const found: { txid: string; vout: number; chain: 0 | 1; index: number }[][] = [];
    for (let i = 0; i < addresses.length; i += QUERIES_AT_ONCE) {
      found.push(
        ...(await Promise.all(
          addresses.slice(i, i + QUERIES_AT_ONCE).map(async ({ address, chain, index }) =>
            (await l1.addressUtxos(address)).filter((u) => u.confirmed && u.asset === undefined).map((u) => ({ txid: u.txid, vout: u.vout, chain, index })),
          ),
        )),
      );
    }
    const txs = new Map<string, Promise<string>>();
    const tx = (txid: string) => txs.get(txid) ?? txs.set(txid, txHex(l1, module, txid)).get(txid)!;
    const coins = await Promise.all(found.flat().map(async (coin) => ({ tx: await tx(coin.txid), vout: coin.vout, chain: coin.chain, index: coin.index })));

    let changeIndex: number | undefined;
    for (const { address, index } of account.change) {
      if ((await l1.addressTxCount(address)) === 0) {
        changeIndex = index;
        break;
      }
    }
    if (changeIndex === undefined) throw refusal(`The wallet's first ${WATCHED_CHANGE_ADDRESSES} eCash change addresses are all used.`);
    return { coins, changeIndex };
  }

  /** A module refusal or a Treasury it can't determine, as the user reads it. */
  async function refusing<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof ChainModuleRefusal || error instanceof TreasuryError) throw refusal(error.message);
      throw error;
    }
  }

  return {
    /**
     * Deposits `amount` sats of the wallet's confirmed eCash to `slot`, credited to the Slot's first
     * receive address. Resolves once the M5 is broadcast; throws on refusal or rejection.
     */
    async start(slot: number, amount: string): Promise<{ txid: string; server: string }> {
      if (!/^[1-9][0-9]*$/.test(amount)) throw refusal("The amount must be a whole number of sats.");
      const l1 = await routing.l1();
      const target = await routing.slot(slot);
      if (!target.module.declare().capabilities.includes("depositDestination")) {
        throw refusal(`${target.entry.name} (Slot ${slot}) can't receive Deposits through this wallet.`);
      }
      const destination = target.module.depositDestination(await target.key());
      if (BigInt(amount) < BigInt(destination.minimum)) throw refusal(`The smallest Deposit to Slot ${slot} is ${destination.minimum} sats.`);

      const server = esplora(l1);
      await server.checkChain();
      const treasury = await refusing(() => findTreasury(server, l1.module.treasuryScript(slot), slot));
      if (treasury === undefined) {
        const { activation } = target.network;
        if (activation === undefined) {
          throw refusal(
            `Slot ${slot} has no Treasury yet, and this wallet has no pinned activation for it, so it can't tell whether the Slot is active.`,
          );
        }
        if ((await server.blockHash(activation.height)) !== activation.hash) {
          throw refusal(`${server.url} doesn't have Slot ${slot}'s activation block ${activation.height} (${activation.hash}).`);
        }
      }
      const rate = feeRate(await server.feeEstimates().catch(() => undefined));
      const key = await l1.key();
      const { coins: available, changeIndex } = await coins(server, l1.module, key);
      const order = {
        slot,
        amount,
        destination: destination.destination,
        feeRate: rate,
        coins: available,
        treasury: treasury === undefined ? null : { tx: await txHex(server, l1.module, treasury.txid), vout: treasury.vout },
        changeIndex,
      };
      const psbt = await refusing(async () => l1.module.buildDeposit(order, key));
      await refusing(async () => l1.module.check(psbt));

      const approval = deps.openSigningApproval({ origin: DEPOSIT_REQUESTER, chain: l1.chain });
      let approved = false;
      try {
        const sent = await approveAndSend();
        await deps.cache?.set(cacheKey.depositRefused(slot), null);
        return sent;
      } catch (error) {
        // By now the page that asked may be gone (a popup closes when the approval window opens).
        if (approved) {
          const reason = error instanceof ProviderRpcError || error instanceof SidechainServerError ? error.message : "Internal wallet error.";
          await deps.cache?.set(cacheKey.depositRefused(slot), { slot, value: amount, reason, at: deps.now() } satisfies RefusedDeposit);
        }
        throw error;
      }

      async function approveAndSend(): Promise<{ txid: string; server: string }> {
        let finalized: { tx: string; txid: string };
        let vout: number;
        try {
          if (!(await deps.isUnlocked()) && !(await approval.unlock())) throw rejected();
          const decoded = await refusing(async () => l1.module.decode(psbt, await l1.key()));
          if (decoded.kind !== "clear") throw new Error(`The wallet can't fully explain the Deposit it built: ${decoded.reason}`);
          const credit: DepositCredit = {
            chain: target.chain,
            chainName: target.entry.name,
            address: destination.address,
            yours: true,
            confirmations: confirmationsToCredit(target.network),
          };
          const view = depositView(decoded.view, slot, amount, destination.destination, credit);
          vout = view.outputs.find((o) => o.destination.kind === "deposit")!.index;
          const prompt: SignPrompt = { origin: DEPOSIT_REQUESTER, chain: l1.chain, requestId: `deposit-${slot}`, decoded: { kind: "clear", view } };
          if (!(await approval.confirm(prompt))) throw rejected();
          approved = true;
          const signed = await refusing(async () => l1.module.sign(psbt, await l1.key()));
          finalized = await refusing(async () => l1.module.finalize(signed));
        } finally {
          approval.close();
        }

        let txid: string;
        try {
          txid = await server.broadcast(finalized.tx);
        } catch (error) {
          if (!(error instanceof SidechainServerError)) throw error;
          throw new SidechainServerError(
            error.server,
            `${error.message} Nothing was sent. If another Deposit to Slot ${slot} took its Treasury first, start again to review a new one.`,
          );
        }
        if (txid !== finalized.txid) throw new SidechainServerError(server.url, `${server.url} reported txid ${txid} for transaction ${finalized.txid}.`);
        await deps.store.put({ slot, chainName: target.entry.name, txid, vout, value: amount, address: destination.address, asset: destination.asset, createdAt: deps.now() });
        return { txid, server: server.url };
      }
    },

    /** The Slot's last Deposit refused after approval this session, if not closed since. */
    refused: async (slot: number): Promise<RefusedDeposit | undefined> => (await deps.cache?.get<RefusedDeposit | null>(cacheKey.depositRefused(slot))) ?? undefined,

    /** Forgets the Slot's refused Deposit. */
    dismissRefused: (slot: number) => deps.cache?.set(cacheKey.depositRefused(slot), null) ?? Promise.resolve(),

    /**
     * The Slot's pending Deposits and where each stands: L1 confirmations (from eCash's server), then
     * the wait for the operator, then credited once the Slot's server lists a transaction to the
     * address whose peg-in input claims the Deposit's txid, confirmed or not. A credited Deposit is reported once, then forgotten.
     */
    async list(slot: number): Promise<DepositStatus[]> {
      const pending = (await deps.store.list()).filter((d) => d.slot === slot).sort((a, b) => b.createdAt - a.createdAt);
      if (pending.length === 0) return [];
      const l1 = esplora(await routing.l1());
      const target = await routing.slot(slot);
      const credits = target.network.sidechainServer.api === "esplora" ? deps.esplora(target.entry, target.network) : undefined;
      const required = confirmationsToCredit(target.network);
      let tip: Promise<number> | undefined;

      return Promise.all(
        pending.map(async (deposit): Promise<DepositStatus> => {
          try {
            const status = await l1.txStatus(deposit.txid);
            if (status === undefined) return { ...deposit, state: "notFound", server: l1.url };
            if (!status.confirmed) return { ...deposit, state: "confirming", confirmations: 0, required };
            const confirmations = (await (tip ??= l1.tipHeight())) - status.blockHeight! + 1;
            if (confirmations < required) return { ...deposit, state: "confirming", confirmations, required };
            const claim = { txid: deposit.txid, vout: deposit.vout, blockHash: status.blockHash!, address: deposit.address, value: deposit.value };
            if (credits === undefined) return { ...deposit, state: "awaitingCredit", confirmations, claim };
            // The credit is the transaction to the address whose peg-in input claims this Deposit.
            const credited = (await credits.addressTxs(deposit.address)).some((tx) => tx.vin.some((input) => input.pegin && input.txid === deposit.txid));
            if (!credited) return { ...deposit, state: "awaitingCredit", confirmations, claim, creditServer: credits.url };
            await deps.store.remove(deposit.txid);
            return { ...deposit, state: "credited", creditServer: credits.url };
          } catch (error) {
            if (error instanceof SidechainServerError) return { ...deposit, state: "unavailable", error: error.message };
            throw error;
          }
        }),
      );
    },

    /** Stops watching a Deposit (the funds aren't affected). */
    dismiss: (txid: string) => deps.store.remove(txid),
  };
}

export type Deposits = ReturnType<typeof createDeposits>;
