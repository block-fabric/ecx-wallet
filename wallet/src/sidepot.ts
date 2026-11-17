// Sidepot's own server (Slot 88, docs/adr/0021), the `sidepot` Server API: a small JSON API over
// the game's state, which is a function of eCash's blocks.
//
//   GET <url>/state            the game: round, price, pot, clock, and the eCash height it has read
//   GET <url>/account/<player> a game account: { balance_sats, keys, nonce }, or null if it has none
//
// It reports a balance and nothing else: the account's moves are entries in eCash transactions,
// which go out over eCash's own server (send.ts), and a Deposit's M5 is eCash's too. There is no
// identity check: the API has no block to ask for. What binds the wallet's entries to one Sidepot
// is their signature (the anchor block and the Slot), and eCash's own server passes the check for
// the chain the game is read from.
import { NATIVE_COIN } from "./chain-module";
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

export type SidepotClient = ReturnType<typeof sidepotClient>;

const isCount = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

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

    /** The account of `player` (its x-only key, 64 hex digits), or null if the game has none for it yet. */
    async account(player: string): Promise<SidepotAccount | null> {
      if (!/^[0-9a-f]{64}$/.test(player)) throw new Error(`${player} isn't a Sidepot player key.`);
      const a = await get(`/account/${player}`, "account");
      if (a === null) return null;
      const { balance_sats, keys, nonce } = (typeof a === "object" ? a : {}) as Record<string, unknown>;
      if (!isCount(balance_sats) || !isCount(keys) || !isCount(nonce)) throw malformed("account");
      return { balance: String(balance_sats), keys, nonce };
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
