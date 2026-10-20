# core

The Rust signing core. A Cargo workspace (not a Rust crate per se; `package.json` only wires it into
pnpm):

| Crate | What it is |
|---|---|
| `vault/` (`ecx-vault`) | The Vault: BIP39 create (from caller entropy) and import checks, Argon2id password stretching, Starter derivation (BitWindow's `DeriveStarter`). Pure Rust, no I/O, no RNG. Seam 2 tests in `vault/tests/`. |
| `abi/` (`ecx-wasm-abi`) | The C ABI every module's `.wasm` exports: `alloc`/`dealloc`, a result buffer (`out_ptr`/`out_len`/`out_clear`), status 0 = ok, 1 = UTF-8 error. |
| `vault-wasm/` (`ecx-vault-wasm`) | Thin `extern "C"` wrappers: ships as `vault.wasm`. |

No wasm-bindgen: each `.wasm` imports **nothing** (it exports its own memory). The TypeScript side is
hand-written: `wallet/src/wasm.ts` (generic ABI glue, `CoreModule`) and one typed wrapper per module
(`wallet/src/vault-module.ts`). Randomness always comes in as bytes from the host.

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
4. If it pulls in LWK: `lwk_common` forces getrandom's `js` backend, which adds wasm-bindgen
   imports; vendor it with that feature switched to `custom` and register a failing RNG.
