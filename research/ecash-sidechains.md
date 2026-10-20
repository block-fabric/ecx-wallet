# eCash sidechains and their signature schemes

Research for [#4](https://github.com/marcusmmmz/ecx-wallet/issues/4), part of the Wallet Base map ([#1](https://github.com/marcusmmmz/ecx-wallet/issues/1)).
Researched 2026-10-19, from primary sources only: ecash.com, the LayerTwo Labs GitHub org, and each sidechain's repo, read at its `main` HEAD as cloned that day.

**Question.** Besides the Elements drivechain, which sidechains exist or are planned for eCash? For each one we want its key type and signature scheme, how its keys are derived, its unsigned-transaction format, and whether it has a server or RPC that could act as a **Sidechain Server**. The goal is to learn how general the **Wallet Base**'s signing core has to be.

## Answer in one paragraph

There is no shared curve. The live and planned sidechains use **five unrelated signature families**:

- Schnorr over Ristretto255, in a FROST-compatible form.
- Ed25519.
- SLH-DSA (SPHINCS+, post-quantum).
- secp256k1 ECDSA and Schnorr.
- RedPallas plus Halo2 zero-knowledge proofs, for zSide's shielded pool.

Each chain also derives its keys in its own way. What they do share is the **seed root**: every chain takes a **BIP39 mnemonic with an empty passphrase**. LayerTwo Labs' own wallet (BitWindow / drivechaind) gives each sidechain slot its own "starter" mnemonic, deterministically derived from one master seed.

Most of the chains also share a transaction format. The Rust chassis family covers six of them (Thunder, BitNames, BitAssets, Truthcoin, CoinShift, Photon), and zSide is built on the same chassis. In that family the unsigned payload is a serde `Transaction` over JSON-RPC. The signed bytes are `borsh(Transaction)`, sometimes with a one-byte domain tag in front. The signature is an `Authorization { verifying_key, signature }` for each input.

So the Wallet Base's signing core **cannot be a single-curve core**. It has to be a seed root plus pluggable per-chain signer modules.

## Which sidechains exist

There are two primary listings, and they disagree in places:

- **ecash.com/sidechains** is the public, marketing-level list. It shows seven chains. Five are marked live: Thunder, zSide, BitNames, BitAssets, Truthcoin. Two are marked in progress: Photon, CoinShift. The page gives no slot numbers and nothing about cryptography. ([ecash.com/sidechains](https://ecash.com/sidechains/), fetched 2026-10-19)
- **`chains_config.json` in [drivechain-frontends](https://github.com/LayerTwo-Labs/drivechain-frontends/blob/main/sidechain-orchestrator/chains_config.json)** is the config the BitWindow/drivechaind orchestrator actually ships. I read it at HEAD `6f72ee2`, dated 2026-10-19. It has every chain above plus several third-party slots.

| Slot | Chain | What it is | Repo (from chains_config) | Status (2026-10-19) |
|---|---|---|---|---|
| 1 | Big Block Covenant | Bitcoin Core / Inquisition fork with CTV, CAT, CSFS, APO, CCV | [sohibit/bitcoin](https://github.com/sohibit/bitcoin) (29.x, last push 2026-08-29) | third-party |
| 2 | **BitNames** | Namecoin/BitDNS-style names | [plain-bitnames](https://github.com/LayerTwo-Labs/plain-bitnames) | live (ecash.com) |
| 4 | **BitAssets** | tokens, NFTs, AMM, Dutch auctions | [plain-bitassets](https://github.com/LayerTwo-Labs/plain-bitassets) | live |
| 8 | Solana | "Solana sidechain. Its node runs outside the orchestrator." No repo is listed. drivechaind only drives its BMM ([client.go](https://github.com/LayerTwo-Labs/drivechain-frontends/blob/main/sidechain-orchestrator/sidechain/solana/client.go)) | none | opaque |
| 9 | **Thunder** | high-throughput payments | [thunder-rust](https://github.com/LayerTwo-Labs/thunder-rust) | live |
| 13 | **Truthcoin** | Hivemind prediction markets | [truthcoin-dc](https://github.com/LayerTwo-Labs/truthcoin-dc) | live |
| 24 | **Elements Alpha** (our first chain) | Elements / Liquid fork | [ekulkisnek/liquid-drivechain-signet-adaptation](https://github.com/ekulkisnek/liquid-drivechain-signet-adaptation) | third-party, "not developed by Layer Two Labs" |
| 98 | **zSide** | Zcash-Orchard privacy chain | [iwakura-rein/thunder-orchard](https://github.com/iwakura-rein/thunder-orchard) | live |
| 99 | **Photon** | post-quantum chain | [photon](https://github.com/LayerTwo-Labs/photon) | in progress |
| 130 | FreeBank | credit notes / bills of exchange; a C++ fork of the old BitAssets chassis (Bitcoin Core-derived) | [mbdrivechains/freebank](https://github.com/mbdrivechains/freebank) | third-party, experimental |
| 255 | **CoinShift** | L2 to L1 atomic swaps (BTC, BCH, LTC) | [coinshift-rs](https://github.com/LayerTwo-Labs/coinshift-rs) | in progress |

Notes on that table:

- **EVM chain:** none is current. [LayerTwo-Labs/ethereum-sidechain](https://github.com/LayerTwo-Labs/ethereum-sidechain), a geth fork, was last pushed 2024-04 and is not in `chains_config.json`. If an EVM chain is ever revived, it would bring secp256k1 ECDSA with RLP / EIP-1559 transactions and EIP-712 typed data.
- **zSide repo mismatch:** ecash.com links zSide to [LayerTwo-Labs/zebra](https://github.com/LayerTwo-Labs/zebra), a Zebra (Zcash node) fork last pushed 2025-04-22. The orchestrator instead ships `iwakura-rein/thunder-orchard` (slot 98, active 2026-10-16). I treat thunder-orchard as the real one.
- **Elements slot is unclear:** The orchestrator config and [liquid-signet-integration.md](https://github.com/LayerTwo-Labs/drivechain-frontends/blob/main/liquid-signet-integration.md) (2026-10-19) say slot 24. The Elements fork's own README now says it targets "Betanet slot 130 (historical Alpha slot 24)" as an "operator-authorized FreeBank slot-130 test profile". It also calls itself "not yet a Betanet-ready sidechain release".
- **Older chains:** zcash-sidechain, hivemind, the C++ Thunder/BitAssets, and testchain are all archived and out of scope.

## Per-chain crypto

All file links point to each repo's `main` as of 2026-10-19.

### The Rust chassis family: Thunder, Truthcoin, CoinShift, zSide (transparent), BitNames, BitAssets, Photon

These chains share one codebase lineage: `lib/`, `types/`, `rpc-api/`, `app/` and `cli/`, with jsonrpsee, borsh, blake3, bincode and `tiny-bip39`. What they have in common:

- **Seed:** BIP39 English mnemonic with an **empty passphrase**, `bip39::Seed::new(&mnemonic, "")`, set through the `set_seed_from_mnemonic` RPC. See for example [thunder `lib/wallet/mod.rs` L237-239](https://github.com/LayerTwo-Labs/thunder-rust/blob/main/lib/wallet/mod.rs). Every chain in the family does this.
- **Address:** `blake3_xof(pubkey_bytes)[..20]`, shown as base58. The deposit form is `s<slot>_<base58>_<checksum>` ([thunder `types/address.rs`](https://github.com/LayerTwo-Labs/thunder-rust/blob/main/types/address.rs)).
- **Unsigned payload:** a `Transaction` (inputs = OutPoints, outputs, plus chain-specific data). It travels as serde JSON over JSON-RPC, for example as the argument to `sign_transaction`.
- **Signed message:** the canonical **borsh** encoding of the `Transaction`. BitNames, BitAssets and Truthcoin put a domain-separation byte in front, `Dst::Transaction = 0x00`. They also allow arbitrary messages under `Dst::Arbitrary = 0xFF`.
- **Signed payload:** `Authorized<Transaction> { transaction, authorizations: Vec<Authorization> }`, with one `Authorization { verifying_key, signature }` for each input, in input order. It is submitted with `submit_transaction`.

The family splits three ways on curve and derivation:

| Chain (slot) | Signature scheme | Key derivation from the BIP39 seed | Signed bytes |
|---|---|---|---|
| Thunder (9) | **Schnorr over Ristretto255**, the `frost-ristretto255` crate (FROST-compatible, so threshold-signing ready). Batch-verified ([types/authorization.rs](https://github.com/LayerTwo-Labs/thunder-rust/blob/main/types/authorization.rs)) | **Custom "BIP32-ish" over Ristretto255** ([lib/wallet/bip32.rs](https://github.com/LayerTwo-Labs/thunder-rust/blob/main/lib/wallet/bip32.rs)). Master = HMAC-SHA512("Bitcoin seed", seed), with the IL bytes read as a big-endian scalar after clearing the top 3 bits, mod ℓ. Path `m/43'/1899'/0'/<slot>'/0'/i`; the code calls it "bip43 purpose / eCash Token / purpose / sidechain number / account / index" | `borsh(tx)` |
| Truthcoin (13) | Ristretto255 Schnorr (frost-ristretto255), plus **x25519** encryption keys (libes) | Same BIP32-ish scheme. Path `m/43'/1899'/<purpose>'/13'/0'/i`, where purpose 0 = tx signing, 1 = encryption, 2 = message signing ([lib/wallet/mod.rs L66-73, L1076-1095](https://github.com/LayerTwo-Labs/truthcoin-dc/blob/main/lib/wallet/mod.rs)) | `0x00 ‖ borsh(tx)` |
| CoinShift (255) | Ristretto255 Schnorr (frost-ristretto255) | Same scheme, `m/43'/1899'/0'/255'/0'/i` ([lib/wallet/mod.rs L1082-1094](https://github.com/LayerTwo-Labs/coinshift-rs/blob/main/lib/wallet/mod.rs)) | `borsh(tx)` |
| zSide (98) | Transparent side: Ristretto255 Schnorr (frost-ristretto255). Shielded side: **Zcash Orchard**, meaning RedPallas spend-auth signatures (`reddsa`) plus **Halo2 proofs** that the wallet itself creates (`bundle.create_proof`) ([types/authorization.rs](https://github.com/iwakura-rein/thunder-orchard/blob/main/types/authorization.rs), [lib/wallet/mod.rs](https://github.com/iwakura-rein/thunder-orchard/blob/main/lib/wallet/mod.rs)) | Transparent keys: the same scheme, `m/43'/1899'/0'/98'/0'/i`. Shielded keys: ZIP-32 `orchard::SpendingKey::from_zip32_seed`, with a seed taken from `m/43'/1899'/0'/98'/2'/0'` (lib/wallet/mod.rs L415-427) | `borsh(tx)` plus the Orchard bundle |
| BitNames (2) | **Ed25519** (`ed25519-dalek`), plus x25519 encryption ([types/authorization.rs](https://github.com/LayerTwo-Labs/plain-bitnames/blob/main/types/authorization.rs)) | **ed25519-bip32 (Khovratovich/Cardano "V2")**. Master secret = SHA-256(seed), rehashed until valid; chain code = SHA-256(0x01 ‖ secret). Paths `m/0'/i` for tx signing, `m/1'/i` for encryption, `m/2'/i` for message signing ([lib/wallet/mod.rs L160-190](https://github.com/LayerTwo-Labs/plain-bitnames/blob/main/lib/wallet/mod.rs), [lib/wallet/util.rs](https://github.com/LayerTwo-Labs/plain-bitnames/blob/main/lib/wallet/util.rs)) | `0x00 ‖ borsh(tx)` |
| BitAssets (4) | **Ed25519** (`ed25519-dalek`), plus x25519 encryption | **secp256k1 BIP32** (`bitcoin::bip32::Xpriv`, test network). The 32 secret bytes it derives are used directly as the Ed25519 / x25519 secret. Paths `m/0'/i` tx, `m/1'/i` encryption, `m/2'/i` messages ([lib/wallet.rs L241-320](https://github.com/LayerTwo-Labs/plain-bitassets/blob/main/lib/wallet.rs)) | `0x00 ‖ borsh(tx)` |
| Photon (99) | **SLH-DSA-SHAKE-256s** (FIPS 205, `fips205` crate), in pre-hash mode with SHAKE256 and an empty context. Signatures are 29,792 bytes and public keys 64 bytes (FIPS 205 parameter set) ([types/authorization.rs](https://github.com/LayerTwo-Labs/photon/blob/main/types/authorization.rs)) | **secp256k1 BIP32**, path `m/44'/<"PHOTON" Baudot coin type>'/0'/i'`. The derived secret goes through a blake3 XOF to produce the SLH-DSA `sk_seed`, `sk_prf` and `pk_seed` ([lib/wallet.rs L530-590](https://github.com/LayerTwo-Labs/photon/blob/main/lib/wallet.rs)) | `borsh(tx)` |

Inference, not verified: everything above is pure Rust (dalek, frost, fips205, orchard/halo2). That makes compiling the chains' own `types` crates to WASM plausible. Halo2 proving in a browser would be slow, and building the Orchard proving key takes a large one-time cost.

### Bitcoin-Core-derived chains: Elements Alpha, Big Block Covenant, FreeBank

- **Elements Alpha (24 or 130):** a fork of ElementsProject/elements. That implies secp256k1 ECDSA and Schnorr (taproot) and **Confidential Transactions**: blinding keys, rangeproofs, and surjection proofs, which the README says are mandatory. The unsigned format would be **PSET**, and derivation follows the Elements Core wallet (BIP32 descriptors). I took this from the Elements lineage and did not check it line by line in this fork. Deposits are **Liquid-style peg-ins**: `getpeginaddress`, then fund it on L1, then `claimpegin`. They are not CUSF deposits. The orchestrator talks to it over Core-style JSON-RPC with basic auth ([liquid-signet-integration.md](https://github.com/LayerTwo-Labs/drivechain-frontends/blob/main/liquid-signet-integration.md)).
- **Big Block Covenant (1):** a Bitcoin Inquisition 29.x fork. It uses secp256k1 ECDSA and Schnorr with standard PSBT, and it adds covenant opcodes.
- **FreeBank (130):** "a C++ fork of the BitAssets sidechain chassis", which means the old Bitcoin-Core-based C++ BitAssets. It has a `secp256k1`, Core `wallet` and PSBT RPCs in `src/`. Signing and transactions are therefore Bitcoin-style. On top of that it has its own instrument RPCs (`issuebill`, `endorsebill`, …) ([README](https://github.com/mbdrivechains/freebank)).

### Solana (8)

There is no repo and no wallet integration in the orchestrator. Inference: if it is Solana-like, it uses Ed25519 with Solana's transaction message format. Not verified.

## How the official wallet seeds the sidechains

BitWindow / drivechaind is LayerTwo Labs' reference desktop wallet. It keeps **one master BIP39 seed**. L1 uses that master mnemonic directly. Each sidechain slot gets a **separate 12-word "starter" mnemonic**:

> `DeriveStarter`: BIP32 (secp256k1) derive `m/44'/0'/<slot>'` from the master seed → `SHA256(0x00 ‖ privkey32)` → first 16 bytes as entropy → BIP39 mnemonic.
> — [sidechain-orchestrator/wallet/keygen.go L70-104, L231-240](https://github.com/LayerTwo-Labs/drivechain-frontends/blob/main/sidechain-orchestrator/wallet/keygen.go)

The orchestrator then feeds that mnemonic to the sidechain node. The node applies its own derivation from the table above.

What this means for us: if the Wallet Base reproduces `DeriveStarter`, a user who already has BitWindow can restore the same sidechain funds from one master phrase. It also means the Wallet Base's root-key handling can stay plain BIP39/BIP32 secp256k1, with the per-chain curve work happening below the starter.

## Can anything act as a Sidechain Server?

| Chain | Node RPC | Public (non-wallet) methods a Sidechain Server needs | Notes |
|---|---|---|---|
| Thunder, BitNames, Truthcoin, zSide | jsonrpsee JSON-RPC over HTTP, default `127.0.0.1:6000+slot`, **permissive CORS**. The **public RPC (node API)** and the **private RPC (wallet API)** can run on separate sockets (`--rpc-addr` and `--private-rpc-addr`), but both default to the same address ([thunder app/rpc_server.rs L657-690](https://github.com/LayerTwo-Labs/thunder-rust/blob/main/app/rpc_server.rs), [app/cli.rs](https://github.com/LayerTwo-Labs/thunder-rust/blob/main/app/cli.rs)) | `get_utxos(addresses)`, `get_transaction`, `submit_transaction(Authorized<Transaction>)`, plus block and withdrawal queries ([thunder rpc-api/lib.rs](https://github.com/LayerTwo-Labs/thunder-rust/blob/main/rpc-api/lib.rs)) | Closest to a Sidechain Server today. What is missing is a "build me an unsigned tx for address X" method: `create_transfer` and similar exist only on the wallet side and sign with the node's own seed. A thin server could do coin selection from `get_utxos`, return the `Transaction`, and accept the `Authorized<Transaction>` back. |
| Photon | jsonrpsee, no public/private split | `get_utxos`, `get_transaction`, `submit_transaction`, `sign_transaction` | Same shape as Thunder. |
| BitAssets | jsonrpsee, no split | **No `submit_transaction` or `get_utxos`.** It has only wallet RPCs (`transfer`, `amm_swap`, `my_utxos`, …) and `list_utxos` | A server would need new RPCs added upstream. |
| CoinShift | jsonrpsee, no split, `127.0.0.1:6255` | **No `submit_transaction` or `get_utxos`.** It has wallet and swap RPCs (`create_swap`, `claim_swap`, …) | Same as BitAssets. Swaps also touch L1 chains (BTC, BCH, LTC). |
| Elements, BBC, FreeBank | Bitcoin Core-style JSON-RPC (basic or cookie auth) | `createpsbt`/PSET, `sendrawtransaction`, `scantxoutset`, etc. | A standard Core-style backend. Elements adds peg-in claim proofs. |
| Solana | JSON-RPC, external | unknown | |

In every case the node RPC binds to localhost, has no auth (in the Rust chassis family), and exposes wallet methods on the same socket by default. It is a node, **not** a hardened public Sidechain Server. Each sidechain team would still need to stand up the server role, either as a wrapper or as an upstream RPC addition.

## What this means for the Wallet Base signing core

1. **Curves and schemes the core may need:** Ristretto255 Schnorr (frost-ristretto255 wire format), Ed25519, SLH-DSA-SHAKE-256s, secp256k1 ECDSA, BIP340 Schnorr, and Orchard RedPallas with Halo2 proving (zSide shielded only). Encryption chains (BitNames, BitAssets, Truthcoin) also use **x25519 ECDH keys** for `encrypt_msg` / `decrypt_msg`. So the core needs a decrypt capability, not only signing.
2. **Derivation is per chain.** There are four incompatible schemes: BIP32-ish over Ristretto at `m/43'/1899'/…`, ed25519-bip32 V2, secp256k1 BIP32 with the bytes reused as Ed25519, and secp256k1 BIP32 then blake3 into SLH-DSA. The only common layer is BIP39 to seed, and optionally the BitWindow starter. A generic "give me a key at path P on curve C" API would not reproduce these chains' addresses. The derivation has to be **chain code**, the same code the node runs.
3. **Payloads are mostly uniform.** Six chains, seven counting zSide's transparent side, use borsh bytes with per-input `Authorization`. Three of them (BitNames, BitAssets, Truthcoin) prefix a DST byte. A Signing Request for this family could carry `{chain/slot, tx JSON or borsh bytes, input → key-index map}`. The Core-derived chains want PSBT/PSET instead.
4. **The natural shape is "seed root + per-chain Signer modules":** the Wallet Base holds the master seed, derives per-slot starters, and hands each to a chain-specific module (most likely WASM built from the chain's own Rust `types` crate) that derives keys, signs, and decodes. The **Decoder** for Clear Signing can likely live in the same module.

## Open uncertainties

- **Elements slot (24 or 130)**, whether Elements imports the BitWindow starter at all, and the exact PSET and Confidential Transactions flow in this fork. I did not inspect it line by line.
- **zSide's canonical repo:** ecash.com says `LayerTwo-Labs/zebra` (stale); the orchestrator ships `iwakura-rein/thunder-orchard`. Also unknown: whether Halo2 proving in-browser is acceptable.
- **Solana slot 8:** no repo or protocol detail is public.
- **Photon:** signatures are about 30 KB and SLH-DSA-256s signing is slow. In-browser performance is unmeasured.
- **The 1899' coin type** is used as an "eCash Token" BIP43 purpose path. I don't know whether it's registered in SLIP-44 or whether L2L plans to unify derivation across chains (BitNames, BitAssets and Photon currently differ).
- These repos are moving fast; several were pushed on the research date. The formats above could change before the 2026-10-31 mainnet.
