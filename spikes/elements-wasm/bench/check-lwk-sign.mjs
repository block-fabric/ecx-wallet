// Confirms lwk_wasm really adds a signature to the fixture PSET (not just "no error").
import { readFileSync } from "node:fs";
const dir = new URL("out/chrome/lwk_wasm/", import.meta.url);
const lwk = await import(new URL("glue/lwk_wasm_bg.js", dir));
const fixture = (await import(new URL("fixture.js", dir))).default;
const { instance } = await WebAssembly.instantiate(readFileSync(new URL("glue/lwk_wasm_bg.wasm", dir)), { "./lwk_wasm_bg.js": lwk });
lwk.__wbg_set_wasm(instance.exports);
instance.exports.__wbindgen_start?.();
const net = lwk.Network.regtest(new lwk.AssetId(fixture.net.policy_asset));
const signer = new lwk.Signer(new lwk.Mnemonic(fixture.starter), net);
const signed = signer.sign(new lwk.Pset(fixture.pset)).toString();
const grew = Buffer.from(signed, "base64").length - Buffer.from(fixture.pset, "base64").length;
console.log("lwk_wasm signed PSET grew by", grew, "bytes (a partial sig adds ~107)");
if (grew <= 0) process.exit(1);
