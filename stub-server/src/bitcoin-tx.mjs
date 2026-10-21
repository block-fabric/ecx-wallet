// Bitcoin's raw transaction format, just enough for the stub Esplora server and the tests: encode a
// made-up transaction, parse a real one (segwit or not), and compute txids.
import { createHash } from "node:crypto";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest();
const reverseHex = (hex) => hex.match(/../g).reverse().join("");

/** SHA-256 of a hex string's bytes, hex: Esplora's scripthash (plain byte order). */
export const scripthash = (scriptHex) => sha256(Buffer.from(scriptHex, "hex")).toString("hex");

function varint(n) {
  if (n < 0xfd) return Buffer.from([n]);
  const b = Buffer.alloc(3);
  b[0] = 0xfd;
  b.writeUInt16LE(n, 1);
  return b;
}

/**
 * A non-segwit transaction, hex. `inputs`: `{ txid, vout, script?, sequence? }` (txid in display
 * order); `outputs`: `{ value, script }` (script hex).
 */
export function encodeTx({ version = 2, inputs, outputs, locktime = 0 }) {
  const u32 = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n >>> 0);
    return b;
  };
  const parts = [u32(version), varint(inputs.length)];
  for (const { txid, vout, script = "", sequence = 0xffffffff } of inputs) {
    parts.push(Buffer.from(reverseHex(txid), "hex"), u32(vout), varint(script.length / 2), Buffer.from(script, "hex"), u32(sequence));
  }
  parts.push(varint(outputs.length));
  for (const { value, script } of outputs) {
    const v = Buffer.alloc(8);
    v.writeBigUInt64LE(BigInt(value));
    parts.push(v, varint(script.length / 2), Buffer.from(script, "hex"));
  }
  parts.push(u32(locktime));
  return Buffer.concat(parts).toString("hex");
}

/**
 * Parses a raw transaction (hex): `{ txid, version, inputs: [{ txid, vout, script, sequence,
 * witness }], outputs: [{ value, script }], locktime }`. Throws on anything malformed.
 */
export function parseTx(hex) {
  const b = Buffer.from(hex, "hex");
  if (b.toString("hex") !== hex.toLowerCase()) throw new Error("not hex");
  let at = 0;
  const take = (n) => {
    if (at + n > b.length) throw new Error("truncated transaction");
    const slice = b.subarray(at, at + n);
    at += n;
    return slice;
  };
  const readVarint = () => {
    const first = take(1)[0];
    if (first < 0xfd) return first;
    if (first === 0xfd) return take(2).readUInt16LE();
    if (first === 0xfe) return take(4).readUInt32LE();
    throw new Error("varint too large");
  };
  const version = take(4).readUInt32LE();
  const segwit = b[at] === 0 && b[at + 1] === 1;
  if (segwit) at += 2;
  const startInputs = at;
  const inputs = Array.from({ length: readVarint() }, () => ({
    txid: reverseHex(take(32).toString("hex")),
    vout: take(4).readUInt32LE(),
    script: take(readVarint()).toString("hex"),
    sequence: take(4).readUInt32LE(),
    witness: [],
  }));
  const outputs = Array.from({ length: readVarint() }, () => ({ value: Number(take(8).readBigUInt64LE()), script: take(readVarint()).toString("hex") }));
  const endOutputs = at;
  if (segwit) for (const input of inputs) input.witness = Array.from({ length: readVarint() }, () => take(readVarint()).toString("hex"));
  const locktime = take(4).readUInt32LE();
  if (at !== b.length) throw new Error("trailing bytes");
  // The txid hashes the transaction without its witnesses.
  const stripped = Buffer.concat([b.subarray(0, 4), b.subarray(startInputs, endOutputs), b.subarray(b.length - 4)]);
  const txid = reverseHex(sha256(sha256(stripped)).toString("hex"));
  return { txid, version, inputs, outputs, locktime };
}
