// Receive's QR codes (no browser needed): the wallet's own encoder, bundled into the extension
// (MV3 loads nothing remote), must give a code a scanner reads back as exactly the address.
import assert from "node:assert/strict";
import { test } from "node:test";
import jsQR from "jsqr";
import { importWallet } from "../harness.mjs";

const { qrMatrix } = await importWallet();

/** Draws the matrix as a scanner would see it: black modules on white, with a 4-module quiet zone. */
function scan(matrix, scale = 4) {
  const size = (matrix.length + 8) * scale;
  const pixels = new Uint8ClampedArray(size * size * 4).fill(255);
  matrix.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (!dark) return;
      for (let dy = 0; dy < scale; dy++)
        for (let dx = 0; dx < scale; dx++) {
          const i = (((y + 4) * scale + dy) * size + (x + 4) * scale + dx) * 4;
          pixels.fill(0, i, i + 3);
        }
    }),
  );
  return jsQR(pixels, size, size)?.data;
}

for (const [chain, address] of [
  ["the main chain (BIP84)", "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu"],
  ["Elements+ (unconfidential)", "elements1qew44aehkjstjm56ng2rjrz57vwxh5g9su6dlpm"],
  ["Elements+ (confidential, the longest)", "el1qqvzrwmpx0vq2kqcpnxtgszzlqqvyyqgfdqwjvd4s40rutvcf3zh0kuk6d549cauk00d7cv8tychpk9su4c0h7e0ukgq6ssd9q"],
]) {
  test(`a QR code of ${chain}'s address scans back as exactly that address`, () => {
    const matrix = qrMatrix(address);
    assert.ok(matrix.length >= 21 && matrix.every((row) => row.length === matrix.length), "square, at least version 1");
    assert.equal(scan(matrix), address);
  });
}
