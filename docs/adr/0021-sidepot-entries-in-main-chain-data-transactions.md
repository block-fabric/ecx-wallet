# Sidepot (Slot 88): entries in main-chain data transactions

Sidepot is a game in BIP300 Slot 88 whose state is a function of eCash's own blocks ([the spec](https://sidepot.cash/rules), v0.8, read 2026-11-16). A Deposit to the Slot fills a game account. The account's moves, **entries**, are signed instructions in an `OP_RETURN` output of an ordinary eCash transaction. So its Chain Module has no transactions of its own: it holds one key and signs entries, and the main chain's module carries them.

- **The game account** is one BIP340 key: the key at `m/300'/88'/0'` of the Slot's Starter (its BIP39 seed, no passphrase; purpose 300 for BIP300, then the Slot Sidepot proposed itself for, then account 0), used as it is, with no tweak and nothing derived below it. The path is the same on every network. Its address is `spot:<x-only key, 64 lowercase hex digits>`, which is also a Deposit's destination, in ASCII (69 bytes): `sidepot.wasm` declares `depositDestination`, and the wallet's own Deposit does the rest (ADR 0004).
- **`getAddresses({ slot: 88 })`** answers that account: `address` is `spot:<key>`, and `publicKey` is the account's **32-byte x-only key** in hex, not the 33-byte compressed key other chains answer. Sidepot names a player by that key everywhere, its server's `/account/<key>` included.
- **An entry** is `"SPOT" | version 0 | kind | body | player(32) | nonce(u64) | expires(u32) | sig(64)`, integers little-endian: a BUY (kind 1, 128 bytes: `round(u32) | keys(u16, 1 to 1000) | max_price(u64 sats)`) or a CASHOUT (kind 2, 142 bytes: `amount(u64 sats, 0 = all) | dest(20 bytes)`). `sig` is BIP340 by `player` over `tagged_hash("Sidepot/entry", anchor(32) | slot(1) | every byte before sig)`. The **anchor** is the hash of the eCash block that mined the Slot's proposal, in header byte order; it and the Slot are the module's Chain Entry values (`params.anchor`, `slot`), so an entry made by one network's build counts in no other Sidepot. `core/sidepot` reimplements the reference's `entry.rs` (it may not use its crate, which needs randomness and a global secp context) and signs without auxiliary randomness. Its tests hold it to the reference's bytes: an entry from `sidepot-cli` equals ours up to the signature, and each signature verifies under the other's message.
- **Action links**, through `sendAction({ slot: 88, action })` (ADR 0016), under `sendTransfer`'s Grant:

  ```text
  sidepot:buy?round=<u32>&keys=<1..1000>&max_price=<sats>&nonce=<u64>&expires=<u32>
  sidepot:cashout?amount=<sats, 0 = all>&dest=<40 hex>&nonce=<u64>&expires=<u32>
  ```

  Read strictly: lowercase scheme and verb, each parameter once in any order and no other, numbers in plain decimal digits that fit their field, `dest` 40 hex digits. The site supplies the round, the price limit, the nonce (above the account's last) and the expiry (a tick of the game clock), which only the game's state gives. A bad link is -32602 and another verb 4200, both before any window. The answer is `{ txid }` of the main-chain transaction.
- **The main chain carries it: `l1.wasm`'s `build_data`.** One zero-value `OP_RETURN` with the data in a single minimal push (1 to 255 bytes; from 76 bytes an `OP_PUSHDATA1`, as Sidepot reads its entries), then change. Coins, fee, change and PSBT fields are a Send's, by the same code (`funded`), and it is replay-marked like every L1 spend (ADR 0004). It pays nothing but its fee.
- **The L1 Decoder shows a data output**, `{ kind: "data", data }`, Clear: a zero-value `OP_RETURN` with one push of 1 to 255 bytes, the only one of its transaction and not beside a Deposit. One that holds coins, a second one, or one that isn't a single push stays Blind. The Decoder doesn't read the bytes.
- **Built means Clear** (ADR 0006, 0016). The wallet refuses, as its own bug, a transaction whose Clear View isn't exactly the entry's bytes in its one data output, every input and every other output the wallet's. The approval names the app and shows the entry as `sidepot.wasm` read it back from the signed bytes: what is bought, at most how much per key and in all, the round, the game clock tick after which it lapses, the account and its entry number; for a cashout the amount and the destination, which the wallet can't check as the user's. Below it, the transaction with its fee. Never Blind.
- **It spends the main chain's coins**, so it runs in the main chain's queue and holds its coins with the main chain's Sends and Deposits (`Sends.action`, `actionChain`; the web wallet takes the main chain's spend lock).
- **The entry is signed before the user approves**, so the approval shows the bytes that go out. It leaves the wallet only in the approved transaction.

## The `sidepot` Server API

Slot 88's Chain Entry names `{ "api": "sidepot", "url": … }`: `GET /state` (`l1_height`, `tip_height`, `clock`, `tip_clock`, `round`, `deadline`, `price_sats`, `pot_sats`, `bonus_pool_sats`, `accounts`) and `GET /account/<64 hex>` (`{ balance_sats, keys, nonce }`, or `null`). The wallet reads the account's balance as the chain's ECX; `null` is a balance of 0. History is empty: an account's Deposits and entries are main-chain transactions, in the main chain's history. There is **no identity check**: the API has no block to ask for. The entries' signatures bind them to one Sidepot, and the main chain's own server passes the check for the chain the game is read from; the Chain Entry's `identityBlock` is the anchor. A Deposit is credited once `/state`'s `l1_height` reaches the M5's block.

## Mainnet

`networks.mainnet` is Slot 88 of `ecash:mainnet`, anchor block 982,723 (`0000000000000000019340956c9c00140207ee2ad5c683894a51bbe072bbbf33`, which mined the proposal), active from block 984,540 (`0000000000000000051f22685492e96581b900b4ed9ee5befd871f63c23c8904`), both read from an eCash node on 2026-11-17. Its server is BlockFab's explorer, `https://explorer.blockfab.org/sidepot/api/v1/l2/feature/game`, which relays its own Sidepot node's game reads in the shapes above (`/state`, `/account/<key>`): the origin eCash's and Flush's servers already have, so the CSP names no other. A Deposit shows as credited when that node has read its block. Mainnet is the only network the Chain Entry names, so `cargo test` builds `ecx-sidepot` for it and the other modules for betanet as before.

## Checked

On 2026-11-16, on a private test chain (an eCash regtest with Slot 88 active), with a separate build for that chain that is not part of this change and by hand-run scripts that aren't part of the test suite. In node, with the wallet's own code and that build's modules: a Deposit of 0.5 ECX to Slot 88 was credited to the game account, a `sidepot:buy` for 2 keys was taken by the game (balance 50,000,000 to 48,000,000 sats, nonce 0 to 1), and a `sidepot:cashout` of everything emptied the account. In headless Firefox 140, with that chain's web build: an app on another origin connected through the popup, got the account from `getAddresses`, the wallet's own Deposit was approved in place and credited, and a `sendAction` buy was approved and taken by the game. Nothing has been deposited or played with the mainnet build yet: the mainnet game opens at block 984,960.

## Considered options

- **Depend on the reference crate `sidepot-core`:** rejected. It signs with ambient randomness and a global secp context, and a module here imports nothing (core/README.md).
- **Auxiliary randomness from the host:** not now. BIP340 without it is as valid; it hardens against side channels the module's one-shot call doesn't expose.
- **The entry as a new `to` of `sendTransfer` (`{ data }`):** rejected, as ADR 0016 rejected actions there. A site would hand the wallet bytes to publish, and the wallet couldn't say what they mean.
- **The 33-byte even-parity compressed key as `publicKey`:** rejected. Every place Sidepot names a player takes the x-only key; a site would strip the first byte each time.
- **Any `OP_RETURN` Clear:** rejected. More than one, or one holding coins, is nothing the wallet builds.
- **An identity check through `/state`:** rejected. Nothing in it identifies a chain.

## Consequences

- The main chain's history shows an entry's transaction as "Sent", for its fee (its data output isn't the wallet's, so it isn't "Fee, to yourself"). Nothing marks it as a Sidepot entry yet.
- A link is not kept as run, as Flush's are: the game takes an account's nonce once, and each request is approved on its own.
- The wallet can't know whether the game will take an entry (the price may have moved, the round ended, the nonce passed). The fee is paid either way, and the approval says so.
- A cashout's coin arrives on the Sidepot sidechain, which the wallet doesn't show: it has no addresses there. (Since ADR 0022 it has one, shows its coins, and the approval says whether a cashout pays it.)
- The wallet's own screens don't make entries yet: only an app does, through `sendAction`.
