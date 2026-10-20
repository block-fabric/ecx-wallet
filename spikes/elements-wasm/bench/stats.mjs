export const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
// runs: array of {key: ms}. Returns {key: {median, min, max, first}} rounded to 0.1 ms.
export function summarize(runs) {
  const r1 = (x) => Math.round(x * 10) / 10;
  const out = { n: runs.length };
  for (const k of Object.keys(runs[0] ?? {})) {
    const xs = runs.map((r) => r[k]).filter((x) => typeof x === "number");
    out[k] = { median: r1(median(xs)), min: r1(Math.min(...xs)), max: r1(Math.max(...xs)), first: r1(xs[0]) };
  }
  return out;
}
