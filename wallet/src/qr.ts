// QR codes for Receive: the encoder ships inside the extension (MV3 loads nothing remote).
import qrcode from "qrcode-generator";

/** The QR code of `text` (byte mode, error correction M, the smallest version that fits): `true` is a dark module. */
export function qrMatrix(text: string): boolean[][] {
  const code = qrcode(0, "M");
  code.addData(text, "Byte");
  code.make();
  const size = code.getModuleCount();
  return Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, col) => code.isDark(row, col)));
}
