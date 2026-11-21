# thunder-vectors

A small program built against the Sidepot node's own types (`thunder_types`, from the node's source: a fork of LayerTwo Labs' Thunder, branch `sidepot`). It ties `core/sidepot`'s reimplementation of the node's formats (`src/thunder.rs`, docs/adr/0022) to the node's code, both ways:

- `thunder-vectors generate` writes `../tests/fixtures/thunder-vectors.json`: keys with their verifying keys and addresses, coins and transactions with their canonical bytes, hashes and txids, the node's own signatures, and whole transactions signed as the node's wallet signs them. `../tests/coins.rs` holds the module to every one.
- `thunder-vectors verify < file` reads transactions the wallet signed, with the node's types, and checks each as the node does when it takes one (`verify_authorized_transaction`). Its answer is `../tests/fixtures/wallet-signed.json`. The wallet signs without randomness, so the same test checks it still makes exactly those transactions.

It is not part of the wallet's build or of `cargo test`: it is its own workspace, and needs the node's source checked out beside this repository, as `../../../../sidepot-thunder` from here.

## Writing the fixtures again

After a change to the node's formats, or to what the wallet signs:

```sh
cd core/sidepot/thunder-vectors
cargo build --release                      # Cargo.lock here pins what the node's own lock pins
target/release/thunder-vectors generate > ../tests/fixtures/thunder-vectors.json

cd ../..                                   # core/
ECX_SIDEPOT_WALLET_SIGNED=/tmp/wallet-signed.json cargo test -p ecx-sidepot --test coins   # fails on the old fixture, and writes the file
sidepot/thunder-vectors/target/release/thunder-vectors verify < /tmp/wallet-signed.json > sidepot/tests/fixtures/wallet-signed.json
cargo test -p ecx-sidepot --test coins
```

`verify` fails, and writes nothing, if the node's code refuses any of them.

The fixtures here were written on 2026-11-20 from the node's commit `73326c8`. On 2026-11-21 the node's commit `824e49c` (tag `sidepot-v0.2.0`, with game deposits: docs/adr/0023) wrote them again: every vector already there came out byte for byte the same, and `gameDeposits` was added (game deposit outputs, transactions that make them with the hash each input commits to, and those transactions signed and verified by the node's code). `wallet-signed.json` holds the wallet's transactions of mainnet, the one network Sidepot's Chain Entry names here; `verify`, built against `824e49c`, took the two moves into the game the wallet now signs, beside the eight earlier transactions, unchanged.

The program expects the node's source at `../../../../sidepot-thunder`. To build it against a node source elsewhere without moving anything, copy this repository (its `core/` is enough) to `<dir>/ecx-wallet` and make `<dir>/sidepot-thunder` a symlink to the node source.
