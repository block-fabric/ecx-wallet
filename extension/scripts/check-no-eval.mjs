// Build gate (spec story 50): no shipped script may load code at runtime. Store review rejects it,
// and the CSP would block it anyway; failing the build catches it before either.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const RUNTIME_CODE = /\beval\s*\(|\bnew\s+Function\s*\(/;

/** Throws naming every `.js` file under `dir` that contains `eval(` or `new Function(`. */
export async function checkNoEval(dir) {
  const offenders = [];
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
    const file = path.join(entry.parentPath, entry.name);
    const match = RUNTIME_CODE.exec(await readFile(file, "utf8"));
    if (match) offenders.push(`${path.relative(dir, file)} (${match[0].trim()})`);
  }
  if (offenders.length > 0) throw new Error(`Runtime code loading in shipped scripts: ${offenders.join(", ")}`);
}
