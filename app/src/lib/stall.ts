/**
 * What a stalled chain's notice says: when its last block was mined (seconds since the epoch, from
 * its report's `stalledSince`), and that nothing on it confirms until it moves again.
 */
export function stalledText(chainName: string, since: number): string {
  const at = new Date(since * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  return `${chainName} has made no block since ${at}. Nothing sent on it confirms until it moves again.`;
}
