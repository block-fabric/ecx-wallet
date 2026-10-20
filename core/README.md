# core

The Rust signing core. A Cargo workspace (not a Rust crate per se; `package.json` only wires it into
pnpm):

| Crate | What it is |
|---|---|
| `vault/` (`ecx-vault`) | The Vault: BIP39 create (from caller entropy) and import checks, Argon2id password stretching, Starter derivation (BitWindow's `DeriveStarter`). Pure Rust, no I/O, no RNG. Seam 2 tests in `vault/tests/`. |
| `abi/` (`ecx-wasm-abi`) | The C ABI every module's `.wasm` exports: `alloc`/`dealloc`, a result buffer (`out_ptr`/`out_len`/`out_clear`), status 0 = ok, 1 = UTF-8 error. |
| `vault-wasm/` (`ecx-vault-wasm`) | Thin `extern "C"` wrappers: ships as `vault.wasm`. |
| `elements/` (`ecx-elements`) | The Elements Chain Module (Slot 24, explicit-only): `declare()`, `derive_account(starter, n)` (LWK `elwpkh` at `m/84'/1'/0'`, addresses in `elements1…`). Bundles Slot 24's Chain Entry, `elements/chain-entry.json`: the one home of every betanet value (genesis, policy asset, address params, Sidechain Server URL and Official App placeholders). Seam 2 tests in `elements/tests/`. |
| `elements-wasm/` (`ecx-elements-wasm`) | Thin `extern "C"` wrappers returning JSON: ships as `elements.wasm` (`declare`, `chain_entry`, `derive_account`). |
| `vendor/lwk_common/` | crates.io `lwk_common` 0.19.0 with one line changed (getrandom `js` → `custom`; marked `ECX PATCH`), wired in by `[patch.crates-io]`. |

No wasm-bindgen: each `.wasm` imports **nothing** (it exports its own memory). The TypeScript side is
hand-written: `wallet/src/wasm.ts` (generic ABI glue, `CoreModule`) and one typed wrapper per kind
of module (`wallet/src/vault-module.ts`, `wallet/src/chain-module.ts` for every Chain Module). Randomness always comes in as bytes from the host.

## Build and test

```sh
pnpm --filter @ecx/core build   # core/dist/*.wasm (the root `pnpm build` runs this first)
pnpm --filter @ecx/core test    # cargo test --locked --workspace (the root `pnpm test` runs it)
```

Needs rustup (picks up `rust-toolchain.toml`: Rust 1.98.0 + `wasm32-unknown-unknown`), and a clang
with the WebAssembly backend plus `llvm-ar` for libsecp256k1 (override with
`CC_wasm32_unknown_unknown` / `AR_wasm32_unknown_unknown`; on macOS use Homebrew LLVM). wasm-opt
comes pinned from npm (`binaryen`).

`scripts/build.mjs` builds with `--locked`, remaps build-machine paths out of the binaries, runs
`wasm-opt -Oz` (with the `--enable-*` feature flags rustc's output needs) and fails unless each
module imports nothing but memory (`scripts/check-wasm-imports.mjs`). It prints each module's
sha256. Dependencies are pinned exactly; libsecp256k1 uses its `lowmemory` tables.

## Adding a module (e.g. the Elements Chain Module)

1. A pure crate with its logic and native tests, plus a `<name>-wasm` cdylib crate that depends on
   it and on `ecx-wasm-abi` (re-export the ABI functions as `vault-wasm` does) and exposes
   `#[no_mangle] extern "C"` functions taking `(ptr, len)` pairs / `u32`s and returning
   `ecx_wasm_abi::ret(...)`.
2. Add both to the workspace and one line to `MODULES` in `scripts/build.mjs`.
3. A typed wrapper in `wallet/src/` over `CoreModule` (see `vault-module.ts`); the background
   fetches the `.wasm` lazily via `chrome.runtime.getURL` (see `loadVault` in
   `extension/src/background.ts`). The extension build stages every `core/dist/*.wasm` itself.
   A Chain Module also gets a line in `CHAIN_MODULE_FILES` (`wallet/src/accounts.ts`) and
   implements the `declare` / `chain_entry` / `derive_account` exports `chain-module.ts` expects.
4. If it pulls in LWK: depend on the already-vendored `lwk_common` (see above) and register a
   failing getrandom backend, as `elements/src/lib.rs` does.
