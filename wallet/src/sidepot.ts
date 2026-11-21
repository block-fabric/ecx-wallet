// Sidepot's own server (Slot 88, docs/adr/0021), the `sidepot` Server API: a small JSON API over
// the game's state, which is a function of eCash's blocks.
//
//   GET <url>/state            the game: round, price, pot, clock, and the eCash height it has read
//   GET <url>/account/<player> a game account: { balance_sats, keys, nonce }, or null if it has none
//
// Of the game it reports a balance and nothing else: the account's moves are entries in eCash
// transactions, which go out over eCash's own server (send.ts), and a Deposit's M5 is eCash's too.
// There is no identity check: the API has no block to ask for. What binds the wallet's entries to
// one Sidepot is their signature (the anchor block and the Slot), and eCash's own server passes
// the check for the chain the game is read from.
//
// The Sidepot sidechain's ordinary coins (docs/adr/0022, sidepot-coins.ts) are read and spent here too:
//
//   GET  <url>/coins/<address>      { height, coins }: the address's coins, as the node's list_utxos lists them
//   POST <url>/tx                   a signed transaction (the node's Authorized<Transaction>, JSON) → { txid }
//   GET  <url>/withdrawal-bundle    the withdrawal bundle the chain is waiting on, or null
//   GET  <url>/coin-history/<addr>  what happened to the address's coins, newest first (optional)
//   GET  <url>/withdrawal-notice    what the chain's operator says about withdrawals (optional)
//
// and `/state`'s `fork_height` says from which eCash block the chain takes a move of coins into the
// game (docs/adr/0023): null where the chain has no such height.
import { NATIVE_COIN, type SidepotCoin, type SidepotContent, type SidepotOutPoint } from "./chain-module";
import { serverFetch, SidechainServerError, type Fetch, type SidechainServer } from "./sidechain-server";

/** The game's state, as its server reports it. Unverified by the wallet. */
export interface SidepotState {
  /** The eCash height the game has read up to: a Deposit in a block at or below it is credited. */
  l1Height: number;
  /** eCash's tip, as the server sees it. */
  tipHeight: number;
  /** The game clock (eCash blocks with a transaction) at `l1Height`, and at the tip. */
  clock: number;
  tipClock: number;
  round: number;
  /** The clock tick the round ends at. */
  deadline: number;
  /** Sats per key now. */
  priceSats: number;
  potSats: number;
  bonusPoolSats: number;
  accounts: number;
}

/** A game account, as the server reports it. */
export interface SidepotAccount {
  /** Sats, as a decimal string. */
  balance: string;
  /** Keys held in the current round. */
  keys: number;
  /** The account's entry counter. */
  nonce: number;
}

/** An address's coins on the Sidepot sidechain, as the server reports them. Unverified by the wallet. */
export interface SidepotCoins {
  /** The Sidepot sidechain's height when they were listed. */
  height: number;
  coins: SidepotCoin[];
}

/**
 * One thing that happened to an address's coins, as the server reports it: a Sidepot transaction, or
 * a coin a block or a Deposit made. Unverified by the wallet.
 */
export interface SidepotCoinEvent {
  id: string;
  /** `cashout`: a coin a Sidepot block made for the address (a cashout from the game). */
  kind: "cashout" | "deposit" | "transfer" | "withdrawal";
  txid?: string;
  /** The address's net change, sats, as a signed decimal string. */
  amount: string;
  /** The Sidepot block it is in, and when that block's eCash block was mined (seconds since the epoch). */
  height?: number;
  time?: number;
  /** A withdrawal request it made, and how far that has got (`WithdrawalProgress`). */
  withdrawal?: { amount: string; mainFee: string; mainAddress: string; vout: number; progress: WithdrawalProgress };
  /**
   * The wallet's own record says this transaction moved coins into the game account (docs/adr/0023).
   * The server reports it as a plain transfer: this is the wallet's word, not the server's.
   */
  intoGame?: true;
}

/**
 * From when the chain takes a move of coins into a game account, as its server reports it: the eCash
 * height the rule is active from (`null` if the chain has none), and eCash's tip as the server sees it.
 */
export interface SidepotGameMoves {
  forkHeight: number | null;
  tipHeight: number;
}

/**
 * How far a withdrawal request has got, by the node's own account of its bundle: `waiting` for a
 * bundle; `voting`, its bundle is with the main chain's miners; `paid`, the main chain paid the
 * bundle; `failed`, the bundle failed and the request waits for another.
 */
export type WithdrawalProgress = "waiting" | "voting" | "paid" | "failed";

const PROGRESS: Record<string, WithdrawalProgress> = { waiting: "waiting", pending: "waiting", submitted: "voting", submittedunexpected: "voting", confirmed: "paid", failed: "failed", dropped: "failed" };

export type SidepotClient = ReturnType<typeof sidepotClient>;

const isCount = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/** A Sidepot address as its node writes one: base58 of 20 bytes, 20 to 28 characters. */
export const isSidepotAddress = (text: string) => /^[1-9A-HJ-NP-Za-km-z]{20,28}$/.test(text);

const isTxid = (t: unknown): t is string => typeof t === "string" && /^[0-9a-f]{64}$/.test(t);

function isOutPoint(o: unknown): o is SidepotOutPoint {
  if (o === null || typeof o !== "object") return false;
  const entries = Object.entries(o);
  if (entries.length !== 1) return false;
  const [kind, body] = entries[0] as [string, unknown];
  if (kind === "Deposit") return typeof body === "string" && /^[0-9a-f]{64}:(0|[1-9][0-9]{0,9})$/.test(body);
  const { txid, vout } = (body !== null && typeof body === "object" ? body : {}) as Record<string, unknown>;
  return (kind === "Regular" || kind === "Coinbase") && isTxid(txid) && isCount(vout);
}

function isContent(c: unknown): c is SidepotContent {
  if (c === null || typeof c !== "object") return false;
  const { Value: value, Withdrawal: withdrawal } = c as Record<string, unknown>;
  if (Object.keys(c).length !== 1) return false;
  if (value !== undefined) return isCount(value);
  const { value: paid, main_fee, main_address } = (withdrawal !== null && typeof withdrawal === "object" ? withdrawal : {}) as Record<string, unknown>;
  return isCount(paid) && isCount(main_fee) && typeof main_address === "string";
}

/** True if `c` has the shape of a coin the node lists. The Sidepot module reads one strictly before it spends it. */
export function isSidepotCoin(c: unknown): c is SidepotCoin {
  const { outpoint, output } = (c !== null && typeof c === "object" ? c : {}) as Record<string, unknown>;
  const { address, content } = (output !== null && typeof output === "object" ? output : {}) as Record<string, unknown>;
  return isOutPoint(outpoint) && typeof address === "string" && isSidepotAddress(address) && isContent(content);
}

/** A coin's outpoint as one line of text: what tells two coins apart. */
export function outpointKey(outpoint: SidepotOutPoint): string {
  if ("Deposit" in outpoint) return `deposit:${outpoint.Deposit}`;
  const [kind, { txid, vout }] = "Regular" in outpoint ? (["regular", outpoint.Regular] as const) : (["coinbase", outpoint.Coinbase] as const);
  return `${kind}:${txid}:${vout}`;
}

export function sidepotClient(baseUrl: string, fetchFn: Fetch = (...args) => fetch(...args)) {
  const url = baseUrl.replace(/\/+$/, "");
  const malformed = (what: string) => new SidechainServerError(url, `The Sidechain Server at ${url} sent a malformed ${what}.`);

  async function get(path: string, what: string): Promise<unknown> {
    const answer = await serverFetch(fetchFn, url, path);
    if (!answer.ok) throw new SidechainServerError(url, `The Sidechain Server at ${url} refused: HTTP ${answer.status}`);
    try {
      return await answer.json();
    } catch {
      throw malformed(what);
    }
  }

  return {
    url,

    async state(): Promise<SidepotState> {
      const s = ((await get("/state", "game state")) ?? {}) as Record<string, unknown>;
      const fields = ["l1_height", "tip_height", "clock", "tip_clock", "round", "deadline", "price_sats", "pot_sats", "bonus_pool_sats", "accounts"] as const;
      if (typeof s !== "object" || !fields.every((f) => isCount(s[f]))) throw malformed("game state");
      const n = (f: (typeof fields)[number]) => s[f] as number;
      return {
        l1Height: n("l1_height"),
        tipHeight: n("tip_height"),
        clock: n("clock"),
        tipClock: n("tip_clock"),
        round: n("round"),
        deadline: n("deadline"),
        priceSats: n("price_sats"),
        potSats: n("pot_sats"),
        bonusPoolSats: n("bonus_pool_sats"),
        accounts: n("accounts"),
      };
    },

    /**
     * From when the chain takes a move of coins into a game account: `/state`'s `fork_height` (a
     * height, or null) and `tip_height`. Undefined if the server can't be read or doesn't say: a
     * server too old to report `fork_height` is taken as a chain without the rule.
     */
    async gameMoves(): Promise<SidepotGameMoves | undefined> {
      try {
        const { fork_height, tip_height } = ((await get("/state", "game state")) ?? {}) as Record<string, unknown>;
        if (!isCount(tip_height)) return undefined;
        return { forkHeight: isCount(fork_height) ? fork_height : null, tipHeight: tip_height };
      } catch {
        return undefined;
      }
    },

    /** The account of `player` (its x-only key, 64 hex digits), or null if the game has none for it yet. */
    async account(player: string): Promise<SidepotAccount | null> {
      if (!/^[0-9a-f]{64}$/.test(player)) throw new Error(`${player} isn't a Sidepot player key.`);
      const a = await get(`/account/${player}`, "account");
      if (a === null) return null;
      const { balance_sats, keys, nonce } = (typeof a === "object" ? a : {}) as Record<string, unknown>;
      if (!isCount(balance_sats) || !isCount(keys) || !isCount(nonce)) throw malformed("account");
      return { balance: String(balance_sats), keys, nonce };
    },

    /** The coins the Sidepot sidechain holds at `address` (base58), with the chain's height. */
    async coins(address: string): Promise<SidepotCoins> {
      if (!isSidepotAddress(address)) throw new Error(`${address} isn't a Sidepot address.`);
      const answer = ((await get(`/coins/${address}`, "list of coins")) ?? {}) as Record<string, unknown>;
      const { height, coins } = answer;
      // A coin listed under another address isn't this address's, whatever the server says.
      if (!isCount(height) || !Array.isArray(coins) || !coins.every((c) => isSidepotCoin(c) && c.output.address === address)) throw malformed("list of coins");
      return { height, coins };
    },

    /**
     * Hands the node a signed transaction (`tx`: its `Authorized<Transaction>`, JSON). Answers the
     * txid the node knows it by; a refusal carries the node's own words.
     */
    async submit(tx: string): Promise<string> {
      const answer = await serverFetch(fetchFn, url, "/tx", { method: "POST", headers: { "Content-Type": "application/json" }, body: tx });
      if (!answer.ok) {
        const said = (await answer.text().catch(() => "")).trim().slice(0, 300);
        // The server passes its node's JSON-RPC error on as text: the node's own message is what says why.
        const reason = (/["']message["']:\s*["'](.+?)["']\s*\}?$/.exec(said)?.[1] ?? said).replace(/\.$/, "");
        throw new SidechainServerError(url, `The Sidechain Server at ${url} refused the transaction: ${reason || `HTTP ${answer.status}`}.`);
      }
      const { txid } = ((await answer.json().catch(() => null)) ?? {}) as Record<string, unknown>;
      if (!isTxid(txid)) throw malformed("answer to a transaction");
      return txid;
    },

    /**
     * The withdrawal requests the chain's pending withdrawal bundle pays, as the coins they were:
     * the bundle is what the main chain's miners are voting on. Empty if no bundle is pending.
     */
    /**
     * What happened to `address`'s coins, newest first. Undefined if the server doesn't keep
     * histories or its answer can't be read: the balance never depends on it.
     */
    async coinHistory(address: string): Promise<SidepotCoinEvent[] | undefined> {
      try {
        const { entries } = ((await get(`/coin-history/${address}`, "coin history")) ?? {}) as Record<string, unknown>;
        if (!Array.isArray(entries)) return undefined;
        const kinds = ["cashout", "deposit", "transfer", "withdrawal"];
        return entries.flatMap((raw): SidepotCoinEvent[] => {
          const e = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
          if (typeof e.id !== "string" || !kinds.includes(e.kind as string) || typeof e.amount !== "number" || !Number.isSafeInteger(e.amount)) return [];
          const w = (e.withdrawal !== null && typeof e.withdrawal === "object" ? e.withdrawal : undefined) as Record<string, unknown> | undefined;
          const withdrawal =
            w !== undefined && isCount(w.value) && isCount(w.main_fee) && typeof w.main_address === "string" && isCount(w.vout)
              ? { amount: String(w.value), mainFee: String(w.main_fee), mainAddress: w.main_address, vout: w.vout, progress: PROGRESS[String(w.status)] ?? "waiting" }
              : undefined;
          return [{
            id: e.id,
            kind: e.kind as SidepotCoinEvent["kind"],
            ...(isTxid(e.txid) ? { txid: e.txid } : {}),
            amount: String(e.amount),
            ...(isCount(e.height) ? { height: e.height } : {}),
            ...(isCount(e.time) ? { time: e.time } : {}),
            ...(withdrawal === undefined ? {} : { withdrawal }),
          }];
        });
      } catch {
        return undefined;
      }
    },

    /**
     * What the chain's operator wants said before a withdrawal request, such as when the next bundle
     * is planned. Plain text, at most 600 characters; undefined if the server has none or doesn't
     * answer the question. Reported, like everything else here.
     */
    async withdrawalNotice(): Promise<string | undefined> {
      try {
        const { notice } = ((await get("/withdrawal-notice", "withdrawal notice")) ?? {}) as Record<string, unknown>;
        return typeof notice === "string" && notice.trim() !== "" ? notice.trim().slice(0, 600) : undefined;
      } catch {
        return undefined;
      }
    },

    async withdrawalBundle(): Promise<SidepotCoin[]> {
      const bundle = await get("/withdrawal-bundle", "withdrawal bundle");
      if (bundle === null) return [];
      const { spend_utxos } = (typeof bundle === "object" ? bundle : {}) as Record<string, unknown>;
      if (!Array.isArray(spend_utxos)) throw malformed("withdrawal bundle");
      return spend_utxos.map((pair) => {
        const [outpoint, output] = Array.isArray(pair) ? pair : [];
        const coin = { outpoint, output };
        if (!isSidepotCoin(coin)) throw malformed("withdrawal bundle");
        return coin;
      });
    },
  };
}

/**
 * Sidepot's server as the pull path reads any chain's: the game account's balance as the chain's
 * ECX (its native coin, in sats), 0 while the game has no account for the key. No history: the
 * account's Deposits and entries are eCash transactions, in the main chain's. It builds nothing.
 */
export function sidepotServer(baseUrl: string, fetchFn?: Fetch): SidechainServer {
  const client = sidepotClient(baseUrl, fetchFn);
  const { url } = client;
  const notHere = () => new SidechainServerError(url, `The Sidechain Server at ${url} reports Sidepot's game: it doesn't build transfers.`);
  return {
    url,
    async state(watch) {
      const player = watch.receive[0]?.publicKey;
      if (player === undefined) throw new Error("Sidepot's watch has no game account.");
      const account = await client.account(player);
      const balance = account?.balance ?? "0";
      return { balances: balance === "0" ? [] : [{ asset: NATIVE_COIN, amount: balance }], unconfirmed: [] };
    },
    history: async () => ({ entries: [], partial: false }),
    buildTransfer: async () => {
      throw notHere();
    },
    submit: async () => {
      throw notHere();
    },
  };
}
