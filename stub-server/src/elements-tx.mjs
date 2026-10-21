// Elements' raw transaction format, just enough for the stub Esplora server: parse a transaction
// the wallet broadcasts and compute its txid. No issuances or peg-ins (the wallet builds neither).
import { createHash } from "node:crypto";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest();
const reverseHex = (hex) => hex.match(/../g).reverse().join("");

/**
 * Parses a raw Elements transaction (hex): `{ txid, inputs: [{ txid, vout }], outputs: [{ asset,
 * value, script }] }`, `asset` (display hex) and `value` only when explicit. Throws on anything
 * malformed.
 */
export function parseElementsTx(hex) {
  const b = Buffer.from(hex, "hex");
  if (b.toString("hex") !== hex.toLowerCase() || b.length === 0) throw new Error("not hex");
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
  const bytes = () => take(readVarint());
  /** A confidential asset, value or nonce: null (1 byte), explicit, or a commitment (33 bytes). */
  const confidential = (explicitLength) => {
    const prefix = b[at];
    if (prefix === 0) return take(1) && undefined;
    if (prefix === 1) return take(1 + explicitLength).subarray(1);
    take(33);
    return undefined;
  };

  take(4); // version
  const flags = take(1)[0];
  const startInputs = at;
  const inputs = Array.from({ length: readVarint() }, () => {
    const txid = reverseHex(take(32).toString("hex"));
    const vout = take(4).readUInt32LE();
    if (vout !== 0xffffffff && vout & (0b11 << 30)) throw new Error("issuances and peg-ins aren't supported");
    bytes(); // scriptSig
    take(4); // sequence
    return { txid, vout };
  });
  const outputs = Array.from({ length: readVarint() }, () => {
    const asset = confidential(32);
    const value = confidential(8);
    confidential(32); // nonce
    return {
      ...(asset ? { asset: reverseHex(asset.toString("hex")) } : {}),
      ...(value ? { value: Number(value.readBigUInt64BE()) } : {}),
      script: bytes().toString("hex"),
    };
  });
  take(4); // locktime
  const endLocktime = at;
  if (flags & 1) {
    for (const _ of inputs) {
      bytes(); // issuance amount rangeproof
      bytes(); // inflation keys rangeproof
      for (let n = readVarint(); n > 0; n--) bytes(); // script witness
      for (let n = readVarint(); n > 0; n--) bytes(); // peg-in witness
    }
    for (const _ of outputs) {
      bytes(); // surjection proof
      bytes(); // rangeproof
    }
  }
  if (at !== b.length) throw new Error("trailing bytes");
  // The txid hashes the transaction without its witnesses: flags 0.
  const stripped = Buffer.concat([b.subarray(0, 4), Buffer.from([0]), b.subarray(startInputs, endLocktime)]);
  return { txid: reverseHex(sha256(sha256(stripped)).toString("hex")), inputs, outputs };
}
