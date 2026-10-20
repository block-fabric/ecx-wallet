# Spike: Elements signing core, WASM size and MV3 cold start

Ticket: [#17](https://github.com/marcusmmmz/ecx-wallet/issues/17). This is a throwaway spike on branch `spike/elements-wasm`. It is never merged.

## TL;DR

- **It builds.** An LWK-based Rust core (`lwk_signer` + `lwk_common` + `lwk_wollet` 0.19.0, `Network::CustomElements`) builds for `wasm32-unknown-unknown` with `wasm-pack --target web`. It uses the stock system clang 22, so no special toolchain or sudo is needed. No fallback to bare rust-elements was needed.
- **Size is the real cost.**
  - Default build: **3.56 MB raw, 1.47 MB brotli, 2.69 MB gzip**.
  - With libsecp256k1's `lowmemory` (smaller precomputed tables): **1.43 MB raw, 0.46 MB brotli, 0.56 MB gzip**.
  - About 2.4 MB of the default build is `.rodata`, which is mostly libsecp256k1's precomputed tables. They are linked **twice**, once from `secp256k1-sys` and once from `secp256k1-zkp-sys`.
  - `wasm-opt -Oz` only saves about 3%.
- **Cold start is not a problem.** These numbers are medians of 9 runs on a Ryzen 7 9700X.
  - Brave MV3 service worker, stopped and then woken by a message:
    - `init()` takes **5 ms**.
    - Starter + keys + first PSET signature take about **15 ms** more.
    - Wake-to-reply for the sign path is about **25 ms**. The measured 84 ms round trip also includes blinding and PsetDetails.
  - Firefox MV3 background script: `init()` takes **6 ms**, and the sign path is about **15 ms**.
  - At 4x CPU throttle (plain page): `init` takes 29 ms and the sign path about 88 ms.
- **There is no pure-TypeScript option for CT.**
  - `liquidjs-lib` is archived.
  - Its CT support depended on an Emscripten WASM build of secp256k1-zkp anyway.
  - The "TS" baseline, `lwk_wasm` from npm, is itself WASM: **9.92 MB raw / 2.67 MB brotli**, `init` 12.5 ms in the SW.
  - It also ships as a `--target bundler` build with a `new Function` shim.
- **Prior art matches.** The existing Elements+ wallet extension (credited below) ships a 4.31 MB core and shows the same cold-start profile (SW `init` 5.6 ms).

## What was built

```
spikes/elements-wasm/
  core/         pure-Rust lib (no wasm-bindgen): Starter derivation, LWK signer, CT descriptor, PSET build/blind/sign/details
  core-wasm/    thin wasm-bindgen adapter (+ getrandom/js, + `lowmemory` feature)
  bench/        harness: fixture generator, per-variant MV3 extensions + web pages, Brave/Firefox/Node runners
  build.sh      reproducible build (below)
```

`core` exposes the following. They are wrapped 1:1 in `core-wasm`.

- `starter_mnemonic(master, passphrase, slot)`: the BitWindow-style Starter. It derives BIP32 `m/44'/0'/<slot>'` from the master seed, then takes `SHA256(0x00 ‖ privkey)[:16]` as BIP39 entropy for 12 words (#7).
  - It is unit-tested only for determinism and round-trip. **It is not checked against a BitWindow test vector**, because BitWindow's `keygen_test.go` has none for a fixed slot.
- `Core::new(starter, {policy_asset, genesis_hash, parent_genesis_hash})`: builds an LWK `SwSigner` on the Starter, using `Network::CustomElements(ElementsParamsBuilder…)` and LWK's `wpkh_slip77_descriptor()`.
- `address(i)`: the confidential address at index i. It uses LWK's `el1…` prefix; the chain's own `elementsl…` prefix is left to Elements integration details.
- `make_test_pset(seed)`: stands in for a Sidechain Server. It builds a 1-in/2-out PSET:
  - The input spends a **confidential** fake UTXO paid to our address 0. Its secrets are recovered by SLIP-77 unblinding, as a wallet would do.
  - It has one confidential output and an explicit fee, carries the ELIP-101 genesis field, and is blinded with `blind_last`.
  - It uses a seeded ChaCha RNG, so `core` needs no getrandom.
- `sign_pset(b64)`: the LWK software signer (ECDSA, segwit v0).
- `pset_details(b64)`: LWK `PsetDetails`, the Clear Signing base (balance per asset, fee, recipients). It needs rangeproof rewind, i.e. secp256k1-zkp.

**Benchmark workload.** The fixture is generated once by `bench/gen-fixture.mjs` from the abandon-about mnemonic, giving a 9,216-byte blinded PSET. The policy asset is `5836dcc0…cb2c8`, the slot-24 Beta asset. The genesis hash is a placeholder; for wpkh it only matters for taproot sighash. Every iteration runs these steps:

1. `init`: fetch + compile + instantiate (`await init({module_or_path: url})`).
2. `starter`: Master → Slot-24 Starter (2× PBKDF2-2048 + BIP32).
3. `keys`: signer + descriptor + address 0 from the Starter.
4. `firstSign`: the first PSET signature after init.
5. `details`: PsetDetails (unblinds the input).
6. `blind`: build and blind a fresh PSET (2 rangeproofs/surjection proofs). Not needed in v0, where the server blinds.
7. `warmSign`: a second signature.

**Variants compared:**

| variant | what |
|---|---|
| `core` | this spike, default libsecp256k1 tables (`ECMULT_WINDOW_SIZE=15`) |
| `core-lowmem` | this spike with `--features lowmemory` (window 4, smaller gen table) in both C libsecp builds |
| `elementsplus` | the prior-art Elements+ extension's already-built `dist/chromium` core, copied as is. It is an explicit-asset wallet, so its flow is `new WasmWalletCore(starter)`, `prepare_transfer_json` (explicit, no blinding) and `sign_prepared_json`. Not the same workload: no CT. |
| `lwk_wasm` | `lwk_wasm@0.19.0` from npm (the "TypeScript-only" baseline): `Signer(Mnemonic(starter), Network.regtest(asset))`, `Signer.sign(Pset)`, `Wollet.psetDetails`. It signs the same fixture PSET. |

Each variant is its own MV3 extension. Its service worker statically imports only its own glue, so a wake parses only the variant under test.

## Numbers

### Size

Sizes are in bytes. gzip is `-9`, brotli is q11. Node zlib was used, see `bench/sizes.mjs`.

| variant | `.wasm` raw | gzip | brotli | JS glue raw | glue brotli |
|---|---:|---:|---:|---:|---:|
| **core** | **3,557,535** | 2,692,598 | **1,472,802** | 20,792 | 3,638 |
| **core-lowmem** | **1,428,973** | 561,848 | **457,464** | 20,792 | 3,638 |
| elementsplus (prior art) | 4,313,170 | 2,872,366 | 1,570,278 | 25,330 | 3,994 |
| lwk_wasm 0.19.0 (npm) | 9,919,793 | 5,456,003 | 2,667,513 | 315,636 | 33,251 |

Where the bytes go in `core`, from `twiggy` on an unstripped build:

- The `.rodata` data segment is 2,443,512 bytes. It is mostly libsecp256k1's precomputed `ecmult` tables (about 1 MB each at window 15).
  - The tables appear twice, because `secp256k1-sys` (via rust-bitcoin, used by `bip39`/BIP32/LWK) and `secp256k1-zkp-sys` (used by rust-elements) each vendor and compile a full libsecp256k1.
  - `lowmemory` removes about 2.13 MB of this.
- Function code is the rest. The largest pieces are PSET (de)serialisation, elements-miniscript descriptor parsing (one monomorphised copy per script context), and `lwk_wollet` internals.
- `lwk_wollet` also pulls in **two elements versions** (0.25.3 and 0.26.2).
- `wasm-opt -Oz` (binaryen 117, run by wasm-pack): 3,669,798 → 3,557,535 bytes (−3%).

### Timings

All times are medians in ms. The machine is an AMD Ryzen 7 9700X with 30 GB RAM, running Manjaro Linux (kernel 7.1). All runs are headless.

- The MV3 numbers were measured in **Brave 1.97.59 (Chromium 155.0.8059.85)**, not Chrome.
- Firefox was **158.0**.
- Firefox clamps `performance.now()` to 1 ms, so its numbers are coarse.
- Raw data: `bench/out/results-brave.json`, `bench/out/results-firefox.json`, `bench/out/node.log`.

**(a) Plain web page, Brave.** HTTP cache off, fresh tab per run, n=9.

| variant | init | starter | keys | firstSign | warmSign | details | blind | prepare |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| core | 8.9 | 5.1 | 5.9 | 4.6 | 0.9 | 15.7 | 43.2 | – |
| core-lowmem | 4.5 | 5.2 | 6.0 | 5.8 | 1.4 | 18.4 | 50.1 | – |
| elementsplus | 8.7 | – | 6.8 | 7.1 | 2.2 | – | – | 6.5 |
| lwk_wasm | 17.8 | – | 9.4 | 4.1 | 1.1 | 16.8 | – | – |

**(a') Plain web page, Brave, 4x CPU throttle.** DevTools emulation, a rough proxy for a low-end laptop. n=9.

| variant | init | starter | keys | firstSign | warmSign | details | blind | prepare |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| core | 28.5 | 17.8 | 22.9 | 18.7 | 3.6 | 61.5 | 170.7 | – |
| core-lowmem | 15.3 | 19.7 | 25.8 | 22.9 | 6.0 | 76.5 | 206.1 | – |
| elementsplus | 33.8 | – | 26.5 | 31.8 | 10.1 | – | – | 26.9 |
| lwk_wasm | 68.9 | – | 38.9 | 16.1 | 5.0 | 68.8 | – | – |

**(b) Brave MV3 background service worker, cold wake.** n=9.

How it was measured:

- Listeners are registered synchronously, the work is done lazily inside the `onMessage` handler, and there is no top-level `await`.
- Each run first stops the worker with CDP `ServiceWorker.stopWorker`, then an extension page calls `chrome.runtime.sendMessage`.
- The reply carries a per-instance counter, so a run fails if the worker was not really restarted.

Column meanings:

- `evalAt`, `doneAt`: ms from the worker's `timeOrigin` to top-level evaluation and to the reply.
- `wakeToReply`: measured in the sending page, so it includes the browser's worker startup.
- The workload includes `details` and `blind`. Subtract them for the v0 sign-only path.

| variant | init | starter | keys | firstSign | warmSign | details | blind | prepare | evalAt | doneAt | wakeToReply | ≈ sign-only wake→reply |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| core | 5.1 | 4.9 | 5.8 | 4.5 | 0.9 | 15.4 | 43.0 | – | 2.6 | 83.0 | 84.4 | **≈25** |
| core-lowmem | 3.0 | 5.2 | 6.1 | 5.2 | 1.4 | 18.2 | 50.7 | – | 2.6 | 93.3 | 94.4 | ≈24 |
| elementsplus | 5.6 | – | 6.6 | 7.3 | 2.3 | – | – | 6.4 | 2.6 | 32.4 | 33.6 | ≈31 (incl. prepare) |
| lwk_wasm | 12.5 | – | 9.2 | 3.6 | 1.1 | 16.9 | – | – | 4.5 | 48.5 | 49.7 | ≈31 |

The first message to the worker instance started at extension install had about the same `init` and wake-to-reply: 5.5 ms and 93 ms for `core`. So on this machine there was no visible difference from a cached compile, and it is not possible to tell whether Chromium caches compiled WASM for `chrome-extension://` across SW restarts. V8 compiles WASM lazily (Liftoff). That is why `init` is only a few ms even for 3.5–10 MB modules: part of the compile cost moves into the first call of each function, and it is included in `starter`/`keys`/`firstSign`.

**(c) Firefox MV3 background script (event page).** n=9.

How it was measured:

- `background.scripts` with `"type": "module"`.
- Each run is a fresh temporary install over WebDriver BiDi, so it gets a new `moz-extension://` origin and a truly cold start.
- The script runs the bench on startup and POSTs the result to the harness.
- `installToResult` is measured by the harness.

| variant | init | starter | keys | firstSign | warmSign | details | blind | prepare | evalAt | doneAt | installToResult |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| core | 6 | 3 | 5 | 1 | 1 | 12 | 37 | – | 3 | 68 | 74.2 |
| core-lowmem | 5 | 3 | 6 | 2 | 1 | 13 | 44 | – | 3 | 78 | 83.8 |
| elementsplus | 6 | – | 5 | 3 | 3 | – | – | 3 | 3 | 24 | 28.8 |
| lwk_wasm | 24 | – | 4 | 1 | 1 | 12 | – | – | 7 | 49 | 54.6 |

Firefox plain web page, n=9: `core` init 9, starter 3, keys 5, firstSign 2. `lwk_wasm` init 28. The full table is in `results-firefox.json`.

**Node 22.22.3** (V8, from bytes, fresh process per run; a sanity check): `core` init 2.1, starter 8.0, keys 6.2, firstSign 4.4, details 18.2, blind 53.9.

### lowmemory trade-off

`lowmemory` shrinks the module 2.5x (3.2x brotli) and makes `init` faster. In exchange, ops that use verification-style multiplication get 15–20% slower: `details` (rangeproof rewind) and `blind`. Signing gets about 0.5 ms slower, because `secp256k1-sys` also drops `ECMULT_GEN_PREC_BITS` to 2. All of these are still in the low ms. For a web download it is clearly worth it.

## Build steps (reproducibility)

Toolchain used:

- rustc/cargo 1.98.0 (2026-08-18) with `rustup target add wasm32-unknown-unknown`.
- wasm-pack 0.15.0 (`cargo install wasm-pack --locked`). It downloads its own binaryen **wasm-opt 117** into `~/.cache/.wasm-pack`.
- wasm-bindgen 0.2.129, picked by wasm-pack from `Cargo.lock`.
- clang 22.1.8 and llvm-ar 22.1.8 from the system packages, node 22.22.3, puppeteer-core 25.12.0.

```sh
cd spikes/elements-wasm
./build.sh          # cargo test, 2× wasm-pack (default + lowmemory), dynamic-code check, fixture, assemble, sizes
cd bench
node run-node.mjs all 9
node run-brave.mjs 9           # BRAVE=/path/to/brave to override; throwaway profile in bench/.profile-brave
node run-firefox.mjs 9         # FIREFOX=/path/to/firefox; throwaway profile in bench/.profile-firefox
node report.mjs                # markdown tables from out/results-*.json
```

### clang and wasm32

- `libsecp256k1` (C) is built by the `cc` crate in both `secp256k1-sys` and `secp256k1-zkp-sys`. Their build scripts special-case wasm32 with a bundled minimal libc sysroot, so all that's needed is a clang with the WebAssembly backend (`clang -print-targets | grep wasm32`) and an `llvm-ar`.
- The distro clang 22 has it, so the build worked with **no env vars set**. `build.sh` still pins `CC_wasm32_unknown_unknown=clang` and `AR_wasm32_unknown_unknown=llvm-ar` so the choice is explicit.
- On a system whose clang lacks wasm32 (e.g. Apple's Xcode clang), point those two variables at an LLVM clang/llvm-ar.
- No sudo or system packages were needed.

### Pitfalls hit

1. **wasm-opt 117 vs. modern rustc.** rustc ≥ 1.87 emits bulk-memory (and other post-MVP features) by default, so wasm-pack's bundled wasm-opt fails validation with "Bulk memory operations require bulk memory". The fix is in `core-wasm/Cargo.toml` `[package.metadata.wasm-pack.profile.release] wasm-opt = ["-Oz", "--enable-bulk-memory", "--enable-nontrapping-float-to-int", "--enable-sign-ext", "--enable-mutable-globals", "--enable-reference-types", "--enable-multivalue"]`.
2. **getrandom 0.2.** LWK (`lwk_common`, via `rand::thread_rng`) pulls getrandom 0.2. On wasm32-unknown-unknown it *compiles* without the `js` feature but fails at runtime. Enable `getrandom = { version = "0.2", features = ["js"] }` only in `core-wasm`. `core` itself uses a seeded RNG.
   - With wasm-bindgen 0.2.129 the generated glue contains **no** `new Function`/`eval`, and `build.sh` fails if it ever does.
   - Elements+ (wasm-bindgen 0.2.108) had to regex-patch a `new Function("return this")` shim out of its glue. `lwk_wasm@0.19.0` still ships one (`lwk_wasm_bg.js:9225`). It is an unreachable fallback, so it didn't fire under the MV3 CSP here, but store reviewers may flag it.
3. **LWK on wasm32 needs `default-features = false`** on `lwk_wollet` (the defaults pull esplora/electrum/reqwest/tokio-tungstenite/AMP0), `lwk_signer` (jade/AMP0) and `lwk_common`. With that, no networking crates are compiled.
4. **PsetDetails needs the input's `in_utxo_rangeproof`** (PSET field `PSBT_ELEMENTS_IN_UTXO_RANGEPROOF`) to unblind a confidential input. Without it, LWK returns `InputMineNotUnblindable`. Signing doesn't need it, but Clear Signing does, so **the Signing Request spec must require that Sidechain Servers include it** (and `witness_utxo` + `bip32_derivation`) for every wallet-owned input.
5. **Puppeteer must not attach to the extension's service worker.** With puppeteer's default auto-attach, a worker stopped via CDP never restarted on the next message: the reply timed out. The likely cause is that the debugger waits on start. `targetFilter` excludes `service_worker` targets, and extension ids are computed from the unpacked path instead (sha256 → a–p).
6. **VS Code snap environment breaks Firefox.** `GTK_PATH`/`GIO_MODULE_DIR`/… pointing into `/snap` make Firefox content processes die (`undefined symbol: __libc_pthread_init`). `run-firefox.mjs` strips those variables.

No Chrome or Chrome for Testing was downloaded (`PUPPETEER_SKIP_DOWNLOAD=1`, `puppeteer-core`), and `~/.cache/puppeteer` does not exist. Brave used a throwaway `--user-data-dir` under `bench/.profile-brave` (deleted afterwards).

## TypeScript-only baseline

- **Pure JS for PSET + CT is not viable today.**
  - `liquidjs-lib` (vulpemventures) is **archived** on GitHub (`archived: true`, last push 2026-06-16; npm `6.0.2-liquid.38`).
  - Even when it was maintained, its CT (blinding, unblinding, rangeproof rewind) required injecting `@vulpemventures/secp256k1-zkp`, an Emscripten **WASM** build (npm 3.2.1, last published 2025-01-30).
  - There is no maintained pure-JS rangeproof/surjection-proof implementation.
  - Plain ECDSA signing of a segwit-v0 Elements sighash could be done with `@noble/secp256k1` plus a hand-written PSET parser and Elements sighash. But a Decoder that shows amounts must **unblind** (ECDH + rangeproof rewind), and that needs secp256k1-zkp. So a "TS core" for this chain still ships WASM, or forgoes Clear Signing of amounts.
- **`lwk_wasm` (npm) is the practical "no Rust in our repo" option, and it is still WASM.**
  - It works for this chain's PSETs: it signed the same fixture and produced the same address via `Network.regtest(asset)`.
  - It is 2.8x the size of our core (9.9 MB raw / 2.7 MB brotli), because it carries Esplora/Waterfalls/AMP0/AMP2/Boltz/Jade/Ledger/registry bindings.
  - It is published as `--target bundler` (`import * as wasm from "./lwk_wasm_bg.wasm"`), which neither browser loads natively. Here it was instantiated by hand (what a bundler emits), which works in the MV3 SW. Vite's native path needs top-level await, which is banned in SWs (#6).
  - It has no API for the BitWindow Starter or for a custom genesis hash (#3). Those would need a JS BIP32 (e.g. @scure/bip32) and the ELIP-101 PSET field.

## Prior art: Elements+ wallet extension (credit)

`elementsplus-wallet-extension` (local checkout, commit `b887fc6`, 2026-10-19) is an existing, working MV3 wallet for this same chain, in Chromium and Firefox builds. Its `rust/wallet-core` + `rust/lwk-adapter` WASM core was measured here as is, from its built `dist/chromium/src/wasm/`, copied and never modified.

What it does:

- elements `=0.25.3`, LWK pinned at git rev `55671e82`, wasm-bindgen CLI `=0.2.108`, toolchain 1.89.0.
- Built with plain node scripts (`scripts/build-wasm.mjs`: `cargo build --locked` + `wasm-bindgen --target web`, `SOURCE_DATE_EPOCH`, `CARGO_INCREMENTAL=0`, a sha256 of the output), with no bundler and no wasm-pack.
- Its glue post-processing removes the `new Function` fallback and fails the build if any dynamic code remains. This spike borrowed that check.
- Its CSP is `script-src 'self' 'wasm-unsafe-eval'` in both manifests. Firefox uses `background.scripts` + `type: module`. This matches what the spike used.

Where its numbers differ, and why:

- **Size, 4.31 MB vs our 3.56 MB.**
  - Its release profile is cargo's default: opt-level 3, no LTO, 16 codegen units, and no wasm-opt step.
  - Ours uses `opt-level="z"`, `lto=true`, `codegen-units=1`, `panic="abort"`, `strip`, plus `wasm-opt -Oz`.
  - Both keep both libsecp copies at window 15, so the same `lowmemory` saving (about 2 MB) is available to it.
- **Workload.** It is an explicit-asset wallet, so `sign_prepared_json` signs an unblinded tx and nothing is blinded or rewound. Its `firstSign` (7.3 ms in the SW) also includes its own review-hash checks. Its wake-to-reply (34 ms) is therefore close to our sign-only path (about 25 ms).
- **`init`** is effectively the same (5.6 ms vs 5.1 ms in the SW). Lazy compilation makes init insensitive to module size at this scale.

## Implications for the language decision

1. **Rust/WASM is viable for MV3 on both browsers, with large margins.**
   - A cold-woken Brave service worker is ready and has signed a CT PSET in about 25 ms. Firefox's background script takes about 15 ms.
   - That is roughly 100x below anything a user would notice, and still under 100 ms at 4x CPU throttle.
   - The "WASM recompiles on every SW wake" worry from #6 is real but costs single-digit ms.
   - Keys must still be re-derived (or re-imported) on every wake, about 10 ms for Starter + keys. That belongs to the key-storage ticket, not a reason to avoid WASM.
2. **The choice isn't "Rust vs TypeScript", it's "which WASM".**
   - CT needs secp256k1-zkp (rangeproof rewind for Clear Signing, blinding for future wallet-side funding), and the only maintained implementations are C/Rust.
   - A TS-only core means either `lwk_wasm` (WASM anyway: 2.8x bigger, bundler-target packaging, a `new Function` shim, no Starter or genesis API) or giving up amount decoding.
   - So owning a small Rust `core` + `core-wasm` (the layering from #6) costs little extra and gives control over size, features, API and reproducibility.
3. **Size is the only real cost, and it is mainly a web-app concern.**
   - Ship the `lowmemory` build: 0.46 MB brotli, versus 1.47 MB by default and 2.67 MB for lwk_wasm. The 15–20% slowdown is on ms-scale ops.
   - In the extension the file is local, so size barely matters (`init` doesn't scale with it).
   - Further cuts, unmeasured: drop `lwk_wollet` (only used for descriptor/address/PsetDetails; it brings a second `elements` version), and unify the two vendored libsecp256k1 copies.
4. **Build reproducibility is manageable.**
   - It needs rustc + wasm32 target + clang with the wasm32 backend + llvm-ar, plus a pinned wasm-opt.
   - Pin the toolchain (`rust-toolchain.toml`), `--locked`, `SOURCE_DATE_EPOCH`, and record the wasm sha256 (as Elements+ does).
   - Firefox source review needs Rust, clang and wasm-pack/wasm-bindgen documented. Whether AMO's rebuild reproduces byte-identical output is still untested.
5. **Facts later tickets depend on:**
   - LWK 0.19 `CustomElements` works on wasm32 with `default-features = false`.
   - The `--target web` glue from wasm-bindgen 0.2.129 is MV3-clean.
   - Lazy-init-in-handler works in a Chromium SW and in a Firefox module background script.
   - Signing Requests (PSETs) must carry `witness_utxo`, `in_utxo_rangeproof` and `bip32_derivation` (our fingerprint) for owned inputs, plus the ELIP-101 genesis hash. Otherwise the wallet can sign but can't Clear Sign.
   - LWK addresses use `el1…`/`ert1…`, not the chain's `elementsl…`/`elements1…` (#3).
