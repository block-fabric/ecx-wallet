// The one unit every ECX amount is shown in, on every screen: the background keeps the user's
// pick, and each page reads it once and follows changes made on it.
import { formatAmount } from "@ecx/wallet";
import { getUnit, setUnit, type AssetEntry, type ChainReport, type Unit } from "$lib/background";

let current = $state<Unit>("ecx");
let loaded = $state(false);

getUnit().then(
  (unit) => {
    current = unit;
    loaded = true;
  },
  () => (loaded = true),
);

export const unit = {
  get value(): Unit {
    return current;
  },
  /** False until the stored pick is read: amounts wait for it rather than flicker. */
  get loaded(): boolean {
    return loaded;
  },
  async set(next: Unit) {
    current = await setUnit(next);
  },
  toggle() {
    return this.set(current === "ecx" ? "sats" : "ecx");
  },
};

/** `amount` (base units) of the asset `id`, named as `assets` (its chain's Chain Entry) name it, in the current unit. */
export function amountText(amount: string, id: string, assets: AssetEntry[]): string {
  return formatAmount(amount, assets.find((a) => a.id === id), current);
}

/** Each asset's confirmed amount ("0" if it only has unconfirmed coins), and what's unconfirmed, if any. */
export function assetsOf(report: ChainReport): { asset: string; amount: string; unconfirmed?: string }[] {
  const pending = new Map(report.unconfirmed.map((u) => [u.asset, u.amount]));
  const confirmed = report.balances.map(({ asset, amount }) => ({ asset, amount, unconfirmed: pending.get(asset) }));
  const onlyPending = report.unconfirmed.filter((u) => !report.balances.some((b) => b.asset === u.asset));
  return [...confirmed, ...onlyPending.map(({ asset, amount }) => ({ asset, amount: "0", unconfirmed: amount }))];
}
