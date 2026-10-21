// PROTOTYPE, throw away: made-up home-page data for the UI variants. The shapes are the real ones
// the background sends; the values are invented. Nothing here talks to the extension.

import type { DepositStatus, HistoryEntry, ShownReport } from "$lib/background";
import type { PendingDeposit } from "@ecx/wallet";

export type Scenario = "healthy" | "trouble";

/** Slot 24's policy asset: what a Deposit of eCash sats is credited in. */
export const POLICY_ASSET = "5836dcc06130dcf6a65b6ac493813fd65559955283e44cc3f07966294eccb2c8";
/** Some other asset issued on Slot 24, with no name anywhere. */
export const OTHER_ASSET = "9e41b07a2c6d8f3e5b1a4c7d9e2f6a8b0c3d5e7f9a1b4c6d8e0f2a4b6c8d03f1a6e2";

/**
 * What a Chain Entry could say about an asset, if it said anything (today it doesn't). Assets
 * missing from here show as shortened hex.
 */
export const ASSET_NAMES: Record<string, { ticker: string; name: string; decimals: number }> = {
  "": { ticker: "ECX", name: "eCash", decimals: 8 },
  [POLICY_ASSET]: { ticker: "ECX", name: "eCash on Elements+", decimals: 8 },
};

export interface ProtoChain {
  /** `l1` for eCash, else the Slot. */
  id: "l1" | number;
  name: string;
  chain: string;
  address: string;
  shown: ShownReport;
  history: HistoryEntry[];
  /** Slots only. */
  deposits?: DepositStatus[];
  /** Slots only: its Send needs a fresh report. */
  canSend: boolean;
  /** What its icon says; eCash's "e" and Elements+'s "E+" when missing. */
  mark?: string;
  /** A network that isn't the real one yet, shown as a tag by the name. */
  network?: string;
}

/**
 * Made up: chains this release could ship Chain Entries for that the wallet doesn't show yet.
 * Adding one is turning it on, not describing it: new chains only come with wallet updates.
 */
export const MORE_CHAINS = [
  { slot: 9, name: "Thunder", chain: "ecash:betanet-s9", blurb: "Fast, cheap payments", mark: "T" },
  { slot: 2, name: "BitNames", chain: "ecash:betanet-s2", blurb: "Names you can own", mark: "B" },
  { slot: 13, name: "zSide", chain: "ecash:betanet-s13", blurb: "Private transfers", mark: "z" },
];
export type MoreChain = (typeof MORE_CHAINS)[number];

/** A chain just added: its server reports nothing yet. */
export const addedChain = (more: MoreChain): ProtoChain => ({
  id: more.slot,
  name: more.name,
  chain: more.chain,
  address: `tex1q${more.name.toLowerCase()}0000000000000000000000000000000`,
  shown: {
    refreshing: false,
    report: { chain: more.chain, server: `${more.name.toLowerCase()}.sidechain.example`, balances: [], unconfirmed: [], readAt: Date.now() },
  },
  history: [],
  canSend: false,
  mark: more.mark,
});

const now = Date.now();
const ago = (minutes: number) => Math.floor((now - minutes * 60_000) / 1000);

const ECASH_SERVER = "esplora.beta.ecash.ninja";
const SLOT_SERVER = "s24.sidechain.example";

const claim = {
  txid: "c0ffee5a7b9d1e3f5a7c9e1b3d5f7a9c1e3b5d7f9a1c3e5b7d9f1a3c5e7b9d1f3a",
  vout: 0,
  blockHash: "00000000000000a3f1c2b7e9d4c6a8b0e2f4a6c8e0b2d4f6a8c0e2b4d6f8a0c2",
  address: "tlq1qq02egjncr8g4qn890mrw3jhgupwqymekv383lwpmsfghn36hac5ptpmeewtnftluqyaraa56ung7wf47crkn5fjuhk422d68m",
  value: "250000",
};

const CREDIT_TXID = "d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2";

const pending = (txid: string, value: string): PendingDeposit => ({
  slot: 24,
  chainName: "Elements+",
  txid,
  vout: 0,
  value,
  address: claim.address,
  asset: POLICY_ASSET,
  createdAt: now - 90 * 60_000,
});

function ecash(scenario: Scenario): ProtoChain {
  return {
    id: "l1",
    name: "Main chain",
    network: "Betanet",
    chain: "ecash:betanet",
    address: "tex1qx90cvlsrluvqjj9uv54an54sv0kqfse45nyrxx",
    shown:
      scenario === "healthy"
        ? {
            refreshing: false,
            report: {
              chain: "ecash:betanet",
              server: ECASH_SERVER,
              balances: [{ asset: "", amount: "102500" }],
              unconfirmed: [{ asset: "", amount: "900" }],
              readAt: now,
            },
          }
        : { refreshing: false, error: `Couldn't reach ${ECASH_SERVER}: NetworkError when attempting to fetch resource.` },
    history: [
      { txid: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90", amounts: [{ asset: "", amount: "900" }], confirmed: false, trusted: false },
      { txid: "c0ffee5a7b9d1e3f5a7c9e1b3d5f7a9c1e3b5d7f9a1c3e5b7d9f1a3c5e7b9d1f3a", amounts: [{ asset: "", amount: "-250412" }], confirmed: true, time: ago(95), depositTo: 24 },
      { txid: "5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f", amounts: [{ asset: "", amount: "-188" }], confirmed: true, time: ago(60 * 26), toSelf: true },
      { txid: "9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0", amounts: [{ asset: "", amount: "353100" }], confirmed: true, time: ago(60 * 24 * 3) },
    ],
    canSend: false,
  };
}

function slot24(scenario: Scenario): ProtoChain {
  const report = {
    chain: "ecash:betanet-s24",
    server: SLOT_SERVER,
    balances: [
      { asset: POLICY_ASSET, amount: "48250000" },
      { asset: OTHER_ASSET, amount: "1000" },
    ],
    unconfirmed: [],
    readAt: now - (scenario === "healthy" ? 0 : 7 * 60_000),
  };
  return {
    id: 24,
    name: "Elements+",
    chain: "ecash:betanet-s24",
    address: "tlq1qqvzrwmpx0vq2kqcpnxtgszzlqqvyyqgfdqwjvd4s40rutvcf3zh0kuk6d549cauk00d7cv8tychpk9su4c0h7e0ukgq6ssd9q",
    shown: scenario === "healthy" ? { refreshing: false, report } : { refreshing: true, report },
    history: [
      { txid: "7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b", amounts: [{ asset: POLICY_ASSET, amount: "-1500000" }], confirmed: false, trusted: true },
      { txid: "1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e", amounts: [{ asset: OTHER_ASSET, amount: "1000" }], confirmed: true, time: ago(60 * 5) },
      { txid: "b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4", amounts: [{ asset: POLICY_ASSET, amount: "-120" }], confirmed: true, time: ago(60 * 30), hidden: true },
      { txid: "e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6", amounts: [{ asset: POLICY_ASSET, amount: "49750120" }], confirmed: true, time: ago(60 * 24 * 2) },
    ],
    deposits:
      scenario === "healthy"
        ? [
            { ...pending(claim.txid, "250000"), state: "confirming", confirmations: 37 },
            { ...pending(CREDIT_TXID, "100000"), state: "awaitingCredit", confirmations: 100, claim: { ...claim, txid: CREDIT_TXID, value: "100000" } },
          ]
        : [{ ...pending(claim.txid, "250000"), state: "notFound", server: SLOT_SERVER }],
    canSend: scenario === "healthy",
  };
}

export const chainsFor = (scenario: Scenario): ProtoChain[] => [ecash(scenario), slot24(scenario)];

// ---------- Formatting the variants may share ----------

/** "102500" -> "102,500". */
export const grouped = (amount: string) => {
  const negative = amount.startsWith("-");
  const digits = negative ? amount.slice(1) : amount;
  return (negative ? "−" : "") + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
};

/** Base units in whole coins: "102500" at 8 decimals -> "0.001025". */
export function coins(amount: string, decimals: number): string {
  const negative = amount.startsWith("-");
  const digits = (negative ? amount.slice(1) : amount).padStart(decimals + 1, "0");
  const whole = digits.slice(0, -decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = digits.slice(-decimals).replace(/0+$/, "");
  return (negative ? "−" : "") + whole + (fraction ? `.${fraction}` : "");
}

/** Each asset's confirmed amount, and what's unconfirmed: the real home page's rule. */
export function assetsOf(shown: ShownReport): { asset: string; amount: string; unconfirmed?: string }[] {
  const report = shown.report;
  if (report === undefined) return [];
  const pending = new Map(report.unconfirmed.map((u) => [u.asset, u.amount]));
  const confirmed = report.balances.map(({ asset, amount }) => ({ asset, amount, unconfirmed: pending.get(asset) }));
  const onlyPending = report.unconfirmed.filter((u) => !report.balances.some((b) => b.asset === u.asset));
  return [...confirmed, ...onlyPending.map(({ asset, amount }) => ({ asset, amount: "0", unconfirmed: amount }))];
}

export const readAt = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** "5 min ago", "Yesterday", "Oct 17". */
export function when(seconds: number): string {
  const minutes = Math.round((now / 1000 - seconds) / 60);
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} h ago`;
  if (minutes < 60 * 48) return "Yesterday";
  return new Date(seconds * 1000).toLocaleDateString([], { month: "short", day: "numeric" });
}

export const shortTxid = (txid: string) => `${txid.slice(0, 8)}…${txid.slice(-8)}`;
export const shortAddress = (address: string) => `${address.slice(0, 10)}…${address.slice(-6)}`;

/** Where a Deposit stands, in words: the real home page's strings. */
export function depositState(d: DepositStatus): string {
  switch (d.state) {
    case "confirming":
      return `${d.confirmations} / 100 confirmations on eCash`;
    case "awaitingCredit":
      return `Waiting for the ${d.chainName} chain's operator to credit it (not automatic)`;
    case "credited":
      return `Credited, as reported by ${d.creditServer}`;
    case "notFound":
      return `${d.server} doesn't know this transaction: it may have lost the race for the Treasury, or been dropped`;
    case "unavailable":
      return `Status unavailable: ${d.error}`;
  }
}

/** How an activity row describes itself. */
export function kindOf(entry: HistoryEntry): { label: string; icon: "in" | "out" | "self" | "deposit" } {
  if (entry.depositTo !== undefined) return { label: `Deposit to ${entry.depositTo === 24 ? "Elements+" : `Slot ${entry.depositTo}`}`, icon: "deposit" };
  if (entry.toSelf) return { label: "Fee, to yourself", icon: "self" };
  const out = entry.amounts.some((a) => a.amount.startsWith("-"));
  return out ? { label: "Sent", icon: "out" } : { label: "Received", icon: "in" };
}
