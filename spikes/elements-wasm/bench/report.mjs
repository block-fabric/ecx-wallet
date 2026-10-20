// Prints markdown tables (medians, ms) from out/results-*.json.
import { readFileSync } from "node:fs";
const load = (f) => JSON.parse(readFileSync(new URL(`out/${f}`, import.meta.url), "utf8"));
const b = load("results-brave.json");
const f = load("results-firefox.json");
const V = ["core", "core-lowmem", "elementsplus", "lwk_wasm"];
const COLS = ["init", "starter", "keys", "firstSign", "warmSign", "details", "blind", "prepare"];
const cell = (s, k) => (s?.[k] ? String(s[k].median) : "–");

function table(title, set, extra = []) {
  console.log(`\n**${title}**\n`);
  const cols = [...COLS, ...extra];
  console.log(`| variant | ${cols.join(" | ")} |`);
  console.log(`|---|${cols.map(() => "---:").join("|")}|`);
  for (const v of V) console.log(`| ${v} | ${cols.map((k) => cell(set[v], k)).join(" | ")} |`);
}
table(`Brave ${b.browser}: plain web page (HTTP cache off), median of ${b.n}`, b.web);
table(`Brave: plain web page, 4x CPU throttle, median of ${b.n}`, b.web4x);
const sw = Object.fromEntries(V.map((v) => [v, { ...b.sw[v], wakeToReply: b.swRoundTrip[v].wakeToReply }]));
table(`Brave: MV3 service worker, stop -> message cold wake, median of ${b.n}`, sw, ["evalAt", "doneAt", "wakeToReply"]);
const inst = Object.fromEntries(V.map((v) => [v, Object.fromEntries(Object.entries(b.swInstall[v]).map(([k, x]) => [k, { median: Math.round(x * 10) / 10 }]))]));
table("Brave: first message to the worker started at install (single sample)", inst, ["evalAt", "doneAt", "wakeToReply"]);
table(`Firefox ${f.browser}: plain web page, median of ${f.n}`, f.web);
table(`Firefox: MV3 background script, fresh install each run, median of ${f.n}`, f.bg, ["evalAt", "doneAt", "installToResult"]);
