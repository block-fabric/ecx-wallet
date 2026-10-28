/**
 * What the bottom bar shares across screens: which of home's panels shows, and whether the wallet
 * is unlocked (the bar shows only then), and the Deposits in progress home last counted.
 */
export const nav = $state<{ tab: "assets" | "activity"; unlocked: boolean; deposits: number }>({ tab: "assets", unlocked: false, deposits: 0 });

/**
 * A hash route's path ("/" for home), from `page.url.hash`: the router moves between screens
 * without a `hashchange`, so `location.hash` alone isn't followed.
 */
export function pathOf(hash: string): string {
  const path = hash.replace(/^#/, "").split("?")[0];
  return path === "" ? "/" : path;
}
