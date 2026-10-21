// How amounts are shown: every ECX amount in the one unit the user picked, other assets the Chain
// Entry names in whole units with their ticker, unknown ones in base units (docs/adr/0005). And the
// one total across chains, of each chain's ECX.
import type { AssetEntry } from "./chain-module";
import type { ChainReport } from "./pull-path";
import type { Unit } from "./settings";

/** Digits with thousands grouped. */
function grouped(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Base units in whole units: "102500" at 8 decimals is "0.001025". */
function whole(digits: string, decimals: number): string {
  if (decimals === 0) return grouped(digits);
  const padded = digits.padStart(decimals + 1, "0");
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return grouped(padded.slice(0, -decimals)) + (fraction ? `.${fraction}` : "");
}

/**
 * `amount` (base units, as reported) of `asset` (its Chain Entry's word on it, if any): ECX in
 * `unit`, another named asset in whole units with its ticker, an unknown one in base units.
 */
export function formatAmount(amount: string, asset: AssetEntry | undefined, unit: Unit): string {
  const negative = amount.startsWith("-");
  const digits = (negative ? amount.slice(1) : amount).replace(/^0+(?=\d)/, "");
  const sign = negative ? "−" : "";
  if (asset === undefined) return sign + grouped(digits);
  if (asset.ecx && unit === "sats") return `${sign}${grouped(digits)} sats`;
  return `${sign}${whole(digits, asset.decimals)} ${asset.ticker}`;
}

/** One chain as the total sees it: the assets its Chain Entry names, and its report, if it could be read. */
export interface TotalPart {
  name: string;
  assets: AssetEntry[];
  report?: ChainReport;
}

/** Each chain's ECX added up, in base units; the chains that name an ECX but couldn't be read are `unavailable`. */
export function totalAcrossChains(chains: TotalPart[]): { amount: string; unconfirmed: string; unavailable: string[] } {
  let amount = 0n;
  let unconfirmed = 0n;
  const unavailable: string[] = [];
  for (const { name, assets, report } of chains) {
    const ecx = assets.find((a) => a.ecx);
    if (ecx === undefined) continue;
    if (report === undefined) {
      unavailable.push(name);
      continue;
    }
    for (const b of report.balances) if (b.asset === ecx.id) amount += BigInt(b.amount);
    for (const u of report.unconfirmed) if (u.asset === ecx.id) unconfirmed += BigInt(u.amount);
  }
  return { amount: amount.toString(), unconfirmed: unconfirmed.toString(), unavailable };
}
