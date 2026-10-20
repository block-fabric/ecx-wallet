// Generates out/fixture.js: a blinded PSET (what a Sidechain Server would send) built by our own core.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const here = new URL(".", import.meta.url);
const pkg = new URL("../pkg/", here);
const m = await import(new URL("spike_core_wasm.js", pkg));
m.initSync({ module: readFileSync(new URL("spike_core_wasm_bg.wasm", pkg)) });

const master = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
// Placeholder network identity (the real chain's values are per-network config, see RESULTS.md).
const net = {
  policy_asset: "5836dcc06130dcf6a65b6ac493813fd65559955283e44cc3f07966294eccb2c8",
  genesis_hash: "c1b16ae24f2423aea2ea34552292793b5b5e82999ff1a5cc4f7c1a1a6c0b1a2b",
  parent_genesis_hash: "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f",
};
const starter = m.starterMnemonic(master, "", 24);
const c = new m.Core(starter, net.policy_asset, net.genesis_hash, net.parent_genesis_hash);
const fixture = {
  master, starter, net,
  descriptor: c.descriptor(),
  address0: c.address(0),
  pset: c.makeTestPset(new Uint8Array(32).fill(7)),
  elementsplusAsset: "5836dcc06130dcf6a65b6ac493813fd65559955283e44cc3f07966294eccb2c8",
};
mkdirSync(new URL("out/", here), { recursive: true });
writeFileSync(new URL("out/fixture.js", here), "export default " + JSON.stringify(fixture, null, 1) + ";\n");
console.log("starter:", starter, "\naddress0:", fixture.address0, "\npset bytes:", Buffer.from(fixture.pset, "base64").length);
