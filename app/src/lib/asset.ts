/**
 * An asset id shortened for display: its first and last 8 hex digits. Both ends, so two assets
 * can't pass for each other by sharing a prefix; show the full id alongside wherever it matters.
 */
export const shortAsset = (asset: string) => (asset.length > 20 ? `${asset.slice(0, 8)}…${asset.slice(-8)}` : asset);
