#!/usr/bin/env bash
# Reproduce the spike build. See RESULTS.md "Build steps".
set -euo pipefail
cd "$(dirname "$0")"

# The C parts (libsecp256k1 in secp256k1-sys and secp256k1-zkp-sys) are compiled by the `cc` crate.
# For wasm32-unknown-unknown it needs a clang that has the WebAssembly backend
# (`clang -print-targets | grep wasm32`) and an llvm-ar. The system clang 22 works; these make the
# choice explicit instead of relying on `cc`'s defaults:
export CC_wasm32_unknown_unknown="${CC_wasm32_unknown_unknown:-clang}"
export AR_wasm32_unknown_unknown="${AR_wasm32_unknown_unknown:-llvm-ar}"
export CARGO_INCREMENTAL=0
export SOURCE_DATE_EPOCH=946684800

cargo test -p spike-core --release --locked

wasm-pack build core-wasm --target web --release --out-dir ../pkg -- --locked
wasm-pack build core-wasm --target web --release --out-dir ../pkg-lowmem -- --locked --features lowmemory

# MV3 forbids dynamic code; fail if the glue contains any (the Elements+ extension had to patch one out).
if grep -nE 'new Function|[^a-zA-Z_]eval\(' pkg/spike_core_wasm.js pkg-lowmem/spike_core_wasm.js; then
  echo "glue contains dynamic code evaluation" >&2; exit 1
fi

(cd bench && PUPPETEER_SKIP_DOWNLOAD=1 npm ci && node gen-fixture.mjs && node assemble.mjs)
node bench/sizes.mjs
