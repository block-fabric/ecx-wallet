// Ordinary coins on the Sidepot sidechain (docs/adr/0022). Besides its game accounts, Sidepot has
// coins held by addresses of its own: a game cashout arrives as one, and a coin can ask to be
// withdrawn to the main chain. The wallet has one address there, from the Slot's Starter, and
// follows no chain: Sidepot's server lists the address's coins, the Slot's module builds a transfer,
// a withdrawal request or a move into the wallet's own game account (docs/adr/0023) from them and explains it, the user approves it as any Send, the module
// signs it, and the server hands it to its node.
//
// Everything the server lists is reported, not verified. What the wallet signs is checked by the
// module from the transaction's own bytes: each input commits to its coin by hash, so a server that
// misstates a coin gets a transaction the node refuses, never one that pays something unseen.
//
// Coins a spend took are held back from the next one until the server stops listing them (the
// spend is in a block), or for HOLD_BLOCKS blocks if it never gets there.
//
// A withdrawal request is a coin until the chain hands its bundle to the main chain. From then on,
// through the months the main chain's miners vote on the bundle, Sidepot's server lists it nowhere.
// So the wallet also keeps the requests it made itself, and goes on showing one the server stopped
// listing, saying it can't follow it further, until the user has it forgotten.
//
// A move into the game account is a transfer as far as the server's history goes. The wallet keeps
// the txids of the moves it made itself, to name them as moves in its coin activity.
import { createKeyRouting, type ChainModules, type KeyedChain, type Keys } from "./accounts";
import { ChainModuleRefusal, type BuiltCoinSpend, type ChainEntry, type ClearView, type CoinPayment, type NetworkEntry, type SidepotCoin, type Starter } from "./chain-module";
import { ErrorCode, ProviderRpcError } from "./errors";
import type { SendResult } from "./pull-path";
import { sendRequester } from "./send";
import { SidechainServerError } from "./sidechain-server";
import { isSidepotAddress, outpointKey, type SidepotClient, type SidepotCoinEvent, type SidepotCoins, type SidepotGameMoves } from "./sidepot";
import { rejected, type ApprovalContext, type SignPrompt, type SigningApproval } from "./signing";
import { createSpendQueue, HOLD_BLOCKS, type SpendQueue } from "./spends";
import type { KeyValueStore } from "./vault";

/**
 * What a coin spend pays Sidepot's block producer, in sats: the transaction's inputs less its
 * outputs. The chain sets no minimum; this is the wallet's own flat fee (docs/adr/0022).
 */
export const SIDEPOT_COIN_FEE = "1000";

/** Who the approval names for a withdrawal request the wallet built. */
export const withdrawalRequester = (chainName: string) => `This wallet (Withdraw from ${chainName})`;

/** Who the approval names for a move of coins into the game account the wallet built. */
export const gameMoveRequester = (chainName: string) => `This wallet (Move to game on ${chainName})`;

/** How many of its own moves into the game the wallet remembers, newest kept. */
const MOVES_KEPT = 200;

/**
 * Where a withdrawal request stands, as far as Sidepot's server and the wallet's own record say:
 *
 * - `sent`: the wallet sent it, and the server doesn't list it yet (it isn't in a block).
 * - `waiting`: the server lists it as a coin; no withdrawal bundle includes it yet.
 * - `bundled`: the chain's pending withdrawal bundle includes it; the bundle isn't on the main chain yet.
 * - `handedOver`: the server listed it and no longer does: its bundle went to the main chain, whose
 *   miners vote on it for months. Nothing the server reports says how that goes, or that it was paid.
 * - `unlisted`: the wallet sent it, HOLD_BLOCKS blocks went by, and the server never listed it.
 */
export type WithdrawalStatus = "sent" | "waiting" | "bundled" | "handedOver" | "unlisted";

/** A withdrawal request of the wallet's address that isn't known to be paid. */
export interface WaitingWithdrawal {
  /** Its coin's outpoint, as one line of text. */
  id: string;
  /** Sats to be paid on the main chain. */
  amount: string;
  /** Sats for the main chain's miners. */
  mainFee: string;
  mainAddress: string;
  status: WithdrawalStatus;
  /** Only the wallet's own record shows it (`handedOver`, `unlisted`): `forgetWithdrawal` stops showing it. */
  forgettable?: true;
}

/** The wallet's Sidepot coins as the chain's server reports them. Unverified by the wallet. */
export interface SidepotCoinsReport {
  slot: number;
  chain: string;
  /** Who reported it. */
  server: string;
  /** The wallet's Sidepot address. */
  address: string;
  /** The Sidepot sidechain's height. */
  height: number;
  /** Sats the wallet can spend now: its plain coins, less those a spend of its own holds. */
  balance: string;
  /** Sats of the listed coins a spend of the wallet's holds until it is in a block. */
  held: string;
  /** Withdrawal requests not known to be paid: those the server lists, then those only the wallet's own record has. */
  withdrawals: WaitingWithdrawal[];
  /** Sidepot's fee for a spend, sats. */
  fee: string;
  /** What happened to the address's coins, newest first, if the server keeps histories. The server's account. */
  history?: SidepotCoinEvent[];
  /** What the chain's operator says about withdrawals, such as when the next bundle is planned. The server's words. */
  withdrawalNotice?: string;
  /**
   * From when the chain takes a move of coins into the game account, as the server reports it
   * (docs/adr/0023); `open` once eCash's tip has reached that height. Undefined if the server didn't say.
   */
  gameMoves?: SidepotGameMoves & { open: boolean };
  /** When the server reported it, in milliseconds since the epoch. */
  readAt: number;
}

/** The coins a spend took, held back from later ones. */
interface HeldCoins {
  txid: string;
  /** `outpointKey`s. */
  spent: string[];
  /** The chain's height when the spend went out. */
  height: number;
}

/** A withdrawal request the wallet made, kept so it still shows once the server stops listing it. */
interface MadeWithdrawal {
  /** `outpointKey` of its coin: the first output of the transaction that made it. */
  id: string;
  amount: string;
  mainFee: string;
  mainAddress: string;
  /** The chain's height when it went out. */
  height: number;
  /** The server has listed it since. */
  seen: boolean;
}

/** A move into the game account the wallet made: its txid, so its coin activity can name it. */
interface MadeMove {
  txid: string;
  amount: string;
}

export interface SidepotCoinsDeps extends Keys, ChainModules {
  /** A client for `network`'s default server, which must speak Sidepot's API. */
  sidepot(entry: ChainEntry, network: NetworkEntry): SidepotClient;
  openSigningApproval(context: ApprovalContext): SigningApproval;
  isUnlocked(): Promise<boolean>;
  /** Where held coins and the wallet's own withdrawal requests are kept (`storage.local`): they must outlive the session. */
  store: Pick<KeyValueStore, "get" | "set">;
  /** Runs each chain's spends one at a time. Default: its own. */
  queue?: SpendQueue;
  /** Milliseconds since the epoch. */
  now(): number;
}

/** A refusal the user reads where they asked. */
const refusal = (message: string) => new ProviderRpcError(ErrorCode.InvalidParams, message);

/** A module refusal, as the user reads it. */
async function refusing<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof ChainModuleRefusal) throw refusal(error.message);
    throw error;
  }
}

const isSats = (text: unknown): text is string => typeof text === "string" && /^[1-9][0-9]{0,15}$/.test(text);

/** What a page asked to pay, as the module takes it; refuses anything that isn't a payment. */
function checkedPayment(pay: unknown): CoinPayment {
  const p = (pay !== null && typeof pay === "object" ? pay : {}) as Record<string, unknown>;
  if (!isSats(p.amount)) throw refusal("Enter an amount above zero.");
  if (p.kind === "transfer") {
    const to = typeof p.to === "string" ? p.to.trim() : "";
    if (!isSidepotAddress(to)) throw refusal("Enter the Sidepot address to send to. It is about 27 letters and digits, with no prefix.");
    return { kind: "transfer", to, amount: p.amount };
  }
  if (p.kind === "withdrawal") {
    const mainAddress = typeof p.mainAddress === "string" ? p.mainAddress.trim() : "";
    if (mainAddress === "") throw refusal("Enter the main-chain (eCash) address to withdraw to.");
    if (!isSats(p.mainFee)) throw refusal("Enter a main-chain fee above zero: it is what pays the main chain's miners to include the withdrawal.");
    return { kind: "withdrawal", mainAddress, amount: p.amount, mainFee: p.mainFee };
  }
  // Only ever the wallet's own game account: the page names none, and the module puts in the Starter's.
  if (p.kind === "game" && Object.keys(p).every((k) => k === "kind" || k === "amount")) return { kind: "game", amount: p.amount };
  throw refusal("A Sidepot coin spend is a transfer, a withdrawal or a move into your game account.");
}

/**
 * True if `view` is exactly the spend asked for: the payment first, at most one more output, back
 * to the wallet's own address, every input the wallet's, and the flat fee. Anything else the module
 * built is a wallet bug, refused before the user sees it.
 */
export function isSpendAskedFor(view: ClearView, pay: CoinPayment, fee: string): boolean {
  const [payment, change, ...more] = view.outputs;
  if (payment === undefined || more.length > 0 || view.fee.asset !== "" || view.fee.amount !== fee) return false;
  if (view.inputs.length === 0 || !view.inputs.every((i) => i.yours && i.asset === "")) return false;
  if (change !== undefined && !(change.destination.kind === "address" && change.destination.yours && change.asset === "")) return false;
  const to = payment.destination;
  if (pay.kind === "transfer") {
    return view.dangerousModes.length === 0 && to.kind === "address" && to.address === pay.to && payment.asset === "" && payment.amount === pay.amount;
  }
  if (pay.kind === "game") {
    // The Starter's own game account, as the module re-derived it: never anyone else's.
    return view.dangerousModes.length === 0 && to.kind === "gameAccount" && to.yours && payment.asset === "" && payment.amount === pay.amount;
  }
  const burns = view.dangerousModes.length === 1 && view.dangerousModes[0].kind === "withdrawalBurn" && view.dangerousModes[0].output === payment.index;
  return (
    burns &&
    to.kind === "withdrawal" &&
    // bech32 is the same address in either case; the module writes it in lower case.
    (to.l1Address === pay.mainAddress || to.l1Address === pay.mainAddress.toLowerCase()) &&
    to.payout === pay.amount &&
    to.parentFee === pay.mainFee &&
    payment.asset === "" &&
    payment.amount === (BigInt(pay.amount) + BigInt(pay.mainFee)).toString()
  );
}

export function createSidepotCoins(deps: SidepotCoinsDeps) {
  const routing = createKeyRouting(deps);
  const queue = deps.queue ?? createSpendQueue();

  /** The Slot's chain, if its module has coins and its server speaks Sidepot's API. */
  async function coinsChain(slot: number): Promise<KeyedChain<Starter> & { client: SidepotClient }> {
    const target = await routing.slot(slot);
    if (!target.module.declare().capabilities.includes("coins") || target.network.sidechainServer.api !== "sidepot") {
      throw new ProviderRpcError(ErrorCode.UnsupportedMethod, `This wallet holds no coins of its own on ${target.entry.name}.`);
    }
    return { ...target, client: deps.sidepot(target.entry, target.network) };
  }

  const heldKey = (chain: string) => `sidepot-coins-held:${chain}`;
  const madeKey = (chain: string) => `sidepot-coins-withdrawals:${chain}`;
  const movesKey = (chain: string) => `sidepot-coins-moves:${chain}`;

  /** The stored lists' last change, which the next one waits for: a read and a spend may both change one. */
  let lastChange: Promise<unknown> = Promise.resolve();

  /** Rewrites the list at `key` as `change` makes it of the stored one (or leaves it, if `change` answers the same list), one rewrite at a time. */
  function changeList<T>(key: string, change: (all: T[]) => T[]): Promise<T[]> {
    const run = async () => {
      const all = (await deps.store.get<T[]>(key)) ?? [];
      const next = change(all);
      if (next !== all) await deps.store.set(key, next);
      return next;
    };
    const result = lastChange.then(run, run);
    lastChange = result.catch(() => {});
    return result;
  }

  /**
   * The outpoints the wallet's own spends hold, after letting go of each spend none of whose coins
   * the server lists any more (it is in a block) or that is HOLD_BLOCKS blocks old (it never got there).
   */
  async function heldOutpoints(chain: string, listed: SidepotCoins): Promise<Set<string>> {
    const present = new Set(listed.coins.map((c) => outpointKey(c.outpoint)));
    const kept = await changeList<HeldCoins>(heldKey(chain), (all) => {
      const still = all.filter((h) => h.spent.some((o) => present.has(o)) && listed.height < h.height + HOLD_BLOCKS);
      return still.length === all.length ? all : still;
    });
    return new Set(kept.flatMap((h) => h.spent));
  }

  const value = (coin: SidepotCoin) => ("Value" in coin.output.content ? BigInt(coin.output.content.Value) : 0n);

  /** Sats as the Slot's module writes them in its refusals. */
  const ecx = (sats: bigint) => `${sats / 100_000_000n}.${(sats % 100_000_000n).toString().padStart(8, "0")} ECX`;

  async function spendNow(slot: number, pay: CoinPayment, host: string | undefined): Promise<SendResult> {
    const target = await coinsChain(slot);
    const { module, client } = target;
    const requester = pay.kind === "transfer" ? sendRequester(target.entry.name) : pay.kind === "game" ? gameMoveRequester(target.entry.name) : withdrawalRequester(target.entry.name);
    const approval = deps.openSigningApproval({ origin: requester, chain: target.chain, ...(host === undefined ? {} : { host }) });
    let signed: { tx: string; txid: string };
    let spent: string[];
    let height: number;
    /** A withdrawal's main-chain address as the module wrote it into the transaction. */
    let paidTo: string | undefined;
    try {
      if (!(await deps.isUnlocked()) && !(await approval.unlock())) throw rejected();
      const key = await target.key();
      const { address } = module.coinAddress(key);
      const listed = await client.coins(address);
      height = listed.height;
      const held = await heldOutpoints(target.chain, listed);
      const coins = listed.coins.filter((c) => !held.has(outpointKey(c.outpoint)));
      const heldSats = listed.coins.reduce((sum, c) => (held.has(outpointKey(c.outpoint)) ? sum + value(c) : sum), 0n);
      let built: BuiltCoinSpend;
      try {
        built = module.buildCoinSpend({ coins, pay, fee: SIDEPOT_COIN_FEE }, key);
      } catch (error) {
        if (!(error instanceof ChainModuleRefusal)) throw error;
        // Coins an earlier spend of the wallet's still holds aren't the module's to count: say where they are.
        const waiting = error.code === "insufficientFunds" && heldSats > 0n;
        throw refusal(waiting ? `${error.message} Another ${ecx(heldSats)} is held by a transaction of yours that isn't in a block yet: try again once it is.` : error.message);
      }
      spent = built.spent.map(outpointKey);
      const offered = new Set(coins.map((c) => outpointKey(c.outpoint)));
      if (!spent.every((o) => offered.has(o))) throw new Error("The built spend takes a coin the server never listed.");
      const decoded = await refusing(async () => module.decodeCoinSpend(built.payload, key));
      if (decoded.kind !== "clear") throw new Error(`The wallet can't fully explain the spend it built: ${decoded.reason}`);
      // Anything else is a wallet bug: refused, never shown.
      if (!isSpendAskedFor(decoded.view, pay, SIDEPOT_COIN_FEE)) throw new Error("The built spend isn't the one asked for.");
      const to = decoded.view.outputs[0].destination;
      paidTo = to.kind === "withdrawal" ? to.l1Address : undefined;
      const prompt: SignPrompt = { origin: requester, chain: target.chain, requestId: `coins-${slot}`, decoded };
      if (!(await approval.confirm(prompt))) throw rejected();
      signed = await refusing(async () => module.signCoinSpend(built.payload, await target.key()));
    } finally {
      approval.close();
    }

    let txid: string;
    try {
      txid = await client.submit(signed.tx);
    } catch (error) {
      if (!(error instanceof SidechainServerError)) throw error;
      // The node's own words for a chain whose rule isn't active yet: said plainly instead.
      if (pay.kind === "game" && /not active/i.test(error.message)) {
        throw new SidechainServerError(error.server, `${target.entry.name} doesn't take moves into the game yet: the rule that allows them isn't active on its chain. Nothing was sent.`);
      }
      throw new SidechainServerError(error.server, `${error.message} Nothing was sent.`);
    }
    // It went out, whatever the server answers: its coins are held from here on.
    const taken: HeldCoins = { txid: signed.txid, spent, height };
    await changeList<HeldCoins>(heldKey(target.chain), (all) => [...all, taken]);
    if (pay.kind === "withdrawal") {
      // The request is the transaction's first output. Kept, since the server stops listing it long before it is paid.
      const made: MadeWithdrawal = { id: outpointKey({ Regular: { txid: signed.txid, vout: 0 } }), amount: pay.amount, mainFee: pay.mainFee, mainAddress: paidTo ?? pay.mainAddress, height, seen: false };
      await changeList<MadeWithdrawal>(madeKey(target.chain), (all) => [...all, made]);
    }
    if (pay.kind === "game") {
      const made: MadeMove = { txid: signed.txid, amount: pay.amount };
      await changeList<MadeMove>(movesKey(target.chain), (all) => [...all, made].slice(-MOVES_KEPT));
    }
    if (txid !== signed.txid) throw new SidechainServerError(client.url, `${client.url} reported txid ${txid} for transaction ${signed.txid}.`);
    return { server: client.url, accepted: true, txid };
  }

  return {
    /** The wallet's address on the Slot's sidechain. Throws while locked. */
    async address(slot: number): Promise<string> {
      const target = await coinsChain(slot);
      return target.module.coinAddress(await target.key()).address;
    },

    /** What the Slot's server reports of that address: its spendable sats, and its withdrawal requests still waiting. */
    async reported(slot: number): Promise<SidepotCoinsReport> {
      const target = await coinsChain(slot);
      const { client } = target;
      const { address } = target.module.coinAddress(await target.key());
      const [listed, bundle, notice, history, gameMoves, moves] = await Promise.all([
        client.coins(address),
        client.withdrawalBundle(),
        client.withdrawalNotice(),
        client.coinHistory(address),
        client.gameMoves(),
        deps.store.get<MadeMove[]>(movesKey(target.chain)),
      ]);
      const moved = new Set((moves ?? []).map((m) => m.txid));
      /** How far the node says each withdrawal request of the address has got, by its coin. */
      const progress = new Map((history ?? []).flatMap((e) => (e.withdrawal && e.txid ? [[outpointKey({ Regular: { txid: e.txid, vout: e.withdrawal.vout } }), e.withdrawal.progress] as const] : [])));
      const held = await heldOutpoints(target.chain, listed);
      let balance = 0n;
      let heldSats = 0n;
      for (const coin of listed.coins) {
        if (held.has(outpointKey(coin.outpoint))) heldSats += value(coin);
        else balance += value(coin);
      }
      // A request is a listed coin until its bundle goes to the main chain; the pending bundle names the ones it takes.
      const bundled = new Set(bundle.map((c) => outpointKey(c.outpoint)));
      const requests = new Map<string, SidepotCoin>();
      for (const coin of [...listed.coins, ...bundle.filter((c) => c.output.address === address)]) requests.set(outpointKey(coin.outpoint), coin);
      const withdrawals = [...requests].flatMap(([id, { output }]): WaitingWithdrawal[] => {
        if (!("Withdrawal" in output.content)) return [];
        const { value: paid, main_fee, main_address } = output.content.Withdrawal;
        return [{ id, amount: String(paid), mainFee: String(main_fee), mainAddress: main_address, status: bundled.has(id) ? "bundled" : "waiting" }];
      });
      // Then the wallet's own requests the server doesn't list (any more, or yet).
      const made = await changeList<MadeWithdrawal>(madeKey(target.chain), (all) => (all.some((m) => !m.seen && requests.has(m.id)) ? all.map((m) => (requests.has(m.id) ? { ...m, seen: true } : m)) : all));
      const paid = made.filter((m) => !requests.has(m.id) && progress.get(m.id) === "paid").map((m) => m.id);
      // A request the node says was paid has nothing left to wait for: it shows in the history, and its record goes.
      if (paid.length > 0) await changeList<MadeWithdrawal>(madeKey(target.chain), (all) => all.filter((m) => !paid.includes(m.id)));
      for (const { id, amount, mainFee, mainAddress, height, seen } of made) {
        if (requests.has(id) || paid.includes(id)) continue;
        const status: WithdrawalStatus = seen ? "handedOver" : listed.height < height + HOLD_BLOCKS ? "sent" : "unlisted";
        withdrawals.push({ id, amount, mainFee, mainAddress, status, ...(status === "sent" ? {} : { forgettable: true as const }) });
      }
      return {
        slot,
        chain: target.chain,
        server: client.url,
        address,
        height: listed.height,
        balance: balance.toString(),
        held: heldSats.toString(),
        withdrawals,
        fee: SIDEPOT_COIN_FEE,
        ...(history === undefined ? {} : { history: history.slice(0, 50).map((e) => (e.kind === "transfer" && e.txid !== undefined && moved.has(e.txid) ? { ...e, intoGame: true as const } : e)) }),
        ...(gameMoves === undefined ? {} : { gameMoves: { ...gameMoves, open: gameMoves.forkHeight !== null && gameMoves.tipHeight >= gameMoves.forkHeight } }),
        ...(notice === undefined ? {} : { withdrawalNotice: notice }),
        readAt: deps.now(),
      };
    },

    /**
     * Pays `pay` from the wallet's Sidepot coins: a transfer to a Sidepot address, a withdrawal
     * request to a main-chain address, or a move into the wallet's own game account. Resolves once the server's node took it; throws on refusal
     * or rejection. `host` is the wallet page that shows the approval itself (`ApprovalContext`).
     * One spend per chain at a time, so two never pick the same coins.
     */
    spend(slot: number, pay: unknown, host?: string): Promise<SendResult> {
      const checked = checkedPayment(pay);
      return queue(slot, () => spendNow(slot, checked, host));
    },

    /**
     * Forgets the wallet's own record of the withdrawal request `id` (a `WaitingWithdrawal`'s): it
     * stops showing once the server doesn't list it. The request itself is unaffected.
     */
    async forgetWithdrawal(slot: number, id: string): Promise<void> {
      const target = await coinsChain(slot);
      await changeList<MadeWithdrawal>(madeKey(target.chain), (all) => (all.some((m) => m.id === id) ? all.filter((m) => m.id !== id) : all));
    },
  };
}

export type SidepotCoinsApi = ReturnType<typeof createSidepotCoins>;
