// Shared benchmark bodies. Run unchanged in a web page, an MV3 service worker,
// a Firefox MV3 background script and Node. No top-level await anywhere.
// Each variant's generated entry.js statically imports only its own glue and calls one of these,
// so a woken worker parses only the variant under test.
//
// `src` is either a URL string (browser: streaming fetch+compile) or bytes (Node).

const now = () => performance.now();

export async function runCore(m, init, src, fixture) {
  const t = {};
  let t0 = now();
  if (typeof src === "string") await init({ module_or_path: src });
  else m.initSync({ module: src });
  t.init = now() - t0;

  t0 = now();
  const starter = m.starterMnemonic(fixture.master, "", 24);
  t.starter = now() - t0;
  if (starter !== fixture.starter) throw new Error("starter mismatch");

  t0 = now();
  const c = new m.Core(starter, fixture.net.policy_asset, fixture.net.genesis_hash, fixture.net.parent_genesis_hash);
  const addr = c.address(0);
  t.keys = now() - t0;
  if (addr !== fixture.address0) throw new Error("address mismatch");

  t0 = now();
  c.signPset(fixture.pset);
  t.firstSign = now() - t0;

  t0 = now();
  c.psetDetails(fixture.pset);
  t.details = now() - t0;

  t0 = now();
  c.makeTestPset(new Uint8Array(32).fill(9));
  t.blind = now() - t0;

  t0 = now();
  c.signPset(fixture.pset);
  t.warmSign = now() - t0;
  c.free();
  return t;
}

// Prior art (elementsplus-wallet-extension): explicit-asset wallet with a built-in network profile.
export async function runEp(ep, init, src, fixture) {
  const t = {};
  let t0 = now();
  if (typeof src === "string") await init({ module_or_path: src });
  else ep.initSync({ module: src });
  t.init = now() - t0;

  t0 = now();
  const c = new ep.WasmWalletCore(fixture.starter);
  const a0 = JSON.parse(c.derive_address_json("external", 0, false));
  t.keys = now() - t0;
  const a1 = JSON.parse(c.derive_address_json("external", 1, false));

  t0 = now();
  const asset = fixture.elementsplusAsset;
  const prepared = c.prepare_transfer_json(JSON.stringify({
    recipient: a1.native_address, asset_id: asset, amount: "1000", fee_rate_sat_vb: 1,
    utxos: [{ txid: "11".repeat(32), vout: 0, value: "100000", asset_id: asset,
      script_pubkey_hex: a0.script_pubkey_hex, branch: "external", index: 0 }],
    change_index: 2,
  }));
  t.prepare = now() - t0;
  const hash = JSON.parse(prepared).review_hash;

  t0 = now();
  c.sign_prepared_json(prepared, hash);
  t.firstSign = now() - t0;

  t0 = now();
  c.sign_prepared_json(prepared, hash);
  t.warmSign = now() - t0;
  c.free();
  return t;
}

// lwk_wasm on npm is a `--target bundler` build (`import * as wasm from "./x.wasm"`), which browsers
// can't load natively; instantiate it by hand, i.e. what a bundler would emit.
export async function runLwk(lwk, src, fixture) {
  const t = {};
  let t0 = now();
  const imports = { "./lwk_wasm_bg.js": lwk };
  const { instance } = typeof src === "string"
    ? await WebAssembly.instantiateStreaming(fetch(src), imports)
    : await WebAssembly.instantiate(src, imports);
  lwk.__wbg_set_wasm(instance.exports);
  instance.exports.__wbindgen_start?.();
  t.init = now() - t0;

  t0 = now();
  const net = lwk.Network.regtest(new lwk.AssetId(fixture.net.policy_asset));
  const signer = new lwk.Signer(new lwk.Mnemonic(fixture.starter), net);
  const w = new lwk.Wollet(net, new lwk.WolletDescriptor(fixture.descriptor));
  const addr = w.address(0).address().toString();
  t.keys = now() - t0;
  if (addr !== fixture.address0) throw new Error("lwk_wasm address mismatch: " + addr);

  t0 = now();
  signer.sign(new lwk.Pset(fixture.pset));
  t.firstSign = now() - t0;

  t0 = now();
  w.psetDetails(new lwk.Pset(fixture.pset));
  t.details = now() - t0;

  t0 = now();
  signer.sign(new lwk.Pset(fixture.pset));
  t.warmSign = now() - t0;
  return t;
}
