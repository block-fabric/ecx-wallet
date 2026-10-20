# Research: the Elements drivechain

Ticket: [#3](https://github.com/marcusmmmz/ecx-wallet/issues/3). Researched 2026-10-19. Sources are listed at the end. Where a claim comes from source code, the file is named, at the commit given in the Sources section.

## TL;DR

- **What it is.** The "Elements drivechain" is a fork of `ElementsProject/elements`, run as a BIP300/301 drivechain on eCash in **slot 24**. It lives at **[freewillydev/liquid-drivechain-signet-adaptation](https://github.com/freewillydev/liquid-drivechain-signet-adaptation)**; the account was formerly `ekulkisnek`, and links using that name still redirect. One independent developer maintains it, with a few outside contributors. **LayerTwo Labs does not build it.** LayerTwo's BitWindow/orchestrator ships it as "Elements Alpha (slot 24)" and flags it in code as *not developed by Layer Two Labs*. ecash.com's own sidechain list (slots 01–07) does not mention it at all.
- **Maturity.** The project calls itself "experimental software, not a real-money production release" and says it is "not yet a Betanet-ready sidechain release". eCash mainnet is scheduled for about 2026-10-31.
- **How it differs from Liquid.** There is no federation. Blocks have an `OP_TRUE` block-signing challenge, and their security comes from a BIP301 blind-merged-mining commitment on the parent chain. Dynafed is never active and there is no PAK list. Peg-ins and peg-outs use BIP300 deposits (M5) and withdrawal bundles (M6), not functionary multisig. Taproot and **Simplicity are always active** from genesis. The chain has its own address prefixes, genesis and policy asset.
- **What a wallet sees is plain Elements.** Signatures are ECDSA (segwit v0) plus Schnorr/BIP340 (taproot, using the Elements sighash, which commits to the genesis hash). Confidential Transactions and assets are on: Pedersen commitments, rangeproofs, surjection proofs, and blinding keys carried in confidential addresses. **PSET (BIP370-based) is the native unsigned-transaction format**, through the stock Elements PSBT RPCs.
- **Reusable tooling.** rust-elements 0.27 and LWK 0.19 (including `lwk_wasm` on npm) work for this chain through LWK's `CustomElements` network, with caveats on address prefixes, genesis hash, indexer and explicit-output accounting (see §6). `liquidjs-lib` is **archived** (June 2026), so a new JS-only stack would be a poor choice.

## 1. Which implementation, maintained by whom

| Candidate | Status |
|---|---|
| [freewillydev/liquid-drivechain-signet-adaptation](https://github.com/freewillydev/liquid-drivechain-signet-adaptation) | **The live one.** It is a GitHub fork of ElementsProject/elements. Its last push was 2026-10-18 (commit `efce6b2f`), and it merges Elements upstream regularly (the most recent merge brought in elements#1604 on 2026-09-16). Almost all commits are by `ekulkisnek`/freewillydev, with a few PRs from `seriouscatsoserious`. Releases date back to June 2026; the latest binaries are `elements-alpha-cad1fc1fb-desktop-r2` (2026-09-12). |
| LayerTwo-Labs/drivechain-frontends | **Distributes the binary, does not build it.** `sidechain-orchestrator/chains_config.json` registers `liquid-signet`: `"slot": 24, "name": "Elements Alpha"`, `repo_url` pointing at the repo above, version `cad1fc1fb…`. `liquid-signet-integration.md` (Bjørn Olav, Jun–Aug 2026) adds a "not developed by Layer Two Labs" download warning. `sidechain/elements/node.go` refuses to start the node except on eCash **Alphanet** (`"elements alpha runs only on eCash Alphanet"`). |
| [marcusmmmz/elements-drivechain](https://github.com/marcusmmmz/elements-drivechain) | **Not the live implementation.** It is the project owner's own fork from 2026-05-08: one commit adding BIP301 BMM, with no BIP300 peg. |
| ecash.com/sidechains | Lists only LayerTwo's seven chains: Thunder, zSide, BitNames, BitAssets, Photon, Truthcoin, CoinShift. **Elements is not listed.** |

Other projects in the same ecosystem, all by the same developer: [esplora-liquid-drivechain](https://github.com/freewillydev/esplora-liquid-drivechain), a drivechain-aware [electrs fork](https://github.com/freewillydev/electrs-blockstream) (the stock electrs "cannot decode the Elements Drivechain block-header extension and peg lifecycle metadata"), and [USDD](https://github.com/freewillydev/USDD), an Ethereum-USDT-backed asset built with Simplicity and SP1. Hooks for USDD are part of this chain's consensus identity (`enable_usdd_sp1_annex`).

**Network identity is still moving.** `src/elements_drivechain_identity.h` currently fixes these values:

| Field | Value |
|---|---|
| Sidechain slot | 24 |
| Chain | `-chain=elements` |
| Data directory | `elements-betanet-slot24-v1` |
| Parent genesis | Bitcoin mainnet genesis (eCash forks Bitcoin) |
| Parent checkpoint | 967679 (Betanet) |
| Pegged/policy asset | `5836dcc0…cb2c8` |
| Genesis | `a7754ce0…4d7f` |

The README still says "Betanet slot 130 (historical Alpha slot 24)". The 2026-10-04 commit "Restore Betanet slot 24" and the header both say 24, so the README is stale. LayerTwo's Alphanet client uses a *different* policy asset (`62dce3bd…2da4`). Asset IDs, genesis and ports change from one network (Alpha/Beta/mainnet) to the next, so **a wallet must treat them as per-network configuration, never as constants.**

## 2. How it differs from Liquid

| | Liquid (Blockstream) | Elements drivechain |
|---|---|---|
| Block production | Federation: ≥2/3 of functionaries sign each block, about 1 per minute | `signblockscript = OP_TRUE` (no signer). "Its security boundary is the mandatory, independently verified BIP301 commitment on the parent chain" (`src/kernel/chainparams.cpp`, `CElementsDrivechainParams`) |
| Dynafed / PAK | Active / PAK list controls peg-out destinations | Dynafed `NEVER_ACTIVE`. Withdrawals are BIP300-voted, with no PAK |
| Peg-in | Send BTC to a federation-derived address, wait 102 confirmations, then `claimpegin` with a txout proof | A BIP300 **M5 deposit** on eCash that commits an Elements address. After 100 parent blocks (`PEGIN_MIN_DEPTH`), the node builds a **deterministic credit tx** (`importdrivechaindeposit`) |
| Peg-out | Burn L-BTC to an OP_RETURN; the watchmen pay out in batches (11–35 min) | Burn the pegged asset to an OP_RETURN, then submit a deterministic blinded **M6** to the enforcer for miner voting: 13150 ACKs within 26300 blocks (`WITHDRAWAL_BUNDLE_*`), which takes months, not minutes |
| Script features | Taproot, Simplicity (activated later) | Taproot and Simplicity `ALWAYS_ACTIVE` from genesis |
| Addresses | `ex1`/`lq1` (bech32/blech32) | `elements1…` / `elementsl1…`. Base58 P2PKH=68, P2SH=13, blinded=6, WIF 0x37, xpub `0x18717df5` (same as Elements regtest bytes). The node also *accepts* LWK `ert`/`el` prefixes as input aliases |
| CT | On by default | On. The Alpha network was explicit-only until about 2026-09-16 ("Merge Alpha node changes with confidential payments enabled") |

## 3. Keys and signatures

The upstream Elements script system is unchanged:

- **ECDSA** for segwit v0 (P2WPKH/P2WSH).
- **Schnorr (BIP340)** for taproot (P2TR).

Taproot in Elements uses its own sighash (`doc/taproot-sighash.mediawiki`), which commits to the **genesis block hash**. A signer must therefore know the chain's genesis. ELIP-101 standardises this as a PSET global field `PSBT_ELEMENTS_GLOBAL_GENESIS_HASH`. LWK's software signer reads that field (`lwk_common/src/pset.rs` `get_genesis_hash`, used in `lwk_signer/src/software.rs`).

The chain adds a Taproot annex carrying USDD/SP1 data. It is a consensus feature for USDD controllers and is irrelevant to ordinary wallet spends.

HD keys follow BIP32 with the chain's own xpub/xprv version bytes, which do not affect key derivation. There is no chain-specific coin type. (Unverified: LWK uses coin type 1 for non-mainnet networks.)

## 4. Confidential transactions and blinding keys

This is standard Elements CT/CA (`doc/elements-confidential-transactions.md`, secp256k1-zkp):

- Amounts and asset types are hidden by Pedersen value/asset commitments.
- Rangeproofs and surjection proofs prove the commitments are valid. The node docs say "rangeproof, surjection-proof and amount-conservation checks remain mandatory".
- The fee is an explicit output in the policy asset.
- The receiver puts a **blinding public key** inside the confidential address (blech32 `elementsl…`, or base58 prefix 6). The sender uses ECDH with that key to blind the output. The receiver "rewinds" the rangeproof with the private blinding key.
- Sharing a blinding key gives someone view-only access.
- Wallets usually derive blinding keys deterministically with SLIP-77 and describe wallets with CT descriptors (ELIP-150/151), as LWK does (`Signer.wpkhSlip77Descriptor`).

Peg outputs are **explicit by construction**: the burn output's witness "must stay empty", and the deposit credit pays the committed address. A Decoder should expect a mix of explicit and confidential outputs.

## 5. Is PSET the native unsigned format?

**Yes, for normal sidechain transactions.** The fork keeps upstream Elements' PSET (`doc/pset.mediawiki`: "extends the BIP 370 PSBT format", magic `pset`, PSBTv2 only). It adds proprietary fields for:

- confidential values, assets and proofs,
- issuances,
- peg-in data: `PSBT_ELEMENTS_IN_PEG_IN_TX/…_TXOUT_PROOF/…_GENESIS_HASH/…_CLAIM_SCRIPT/…_VALUE/…_WITNESS`.

The wallet PSBT RPCs (`walletcreatefundedpsbt`, `walletprocesspsbt`, …) are still registered. So a Sidechain Server can hand the Wallet Base a PSET plus the ELIP-101 genesis hash, and the wallet can blind and sign it.

The drivechain-specific RPCs do not use PSET; they build, sign and broadcast with the node's own wallet:

- `sendtomainchain` (withdrawal burn)
- `importdrivechaindeposit` (deposit credit)
- `submitdrivechainwithdrawal`

For a browser wallet, the server would have to express the burn as an ordinary PSET output (see §6).

## 6. How peg-in and peg-out map onto drivechain deposits and withdrawals

Source: `doc/drivechain-peg-operations.md`, `src/pegins.cpp`, `src/drivechain_withdrawal.h`, `src/wallet/rpc/elements.cpp`.

**Deposit (eCash → Elements)**

1. The user creates a slot-24 **M5** on L1 "through the parent wallet/enforcer". This is an L1 transaction that spends the slot's treasury UTXO (CTIP) plus user funds and commits an Elements destination address. **The Wallet Base's L1 signer is what signs here.**
2. After 100 parent confirmations, `importdrivechaindeposit <mainchain_txid> <vout> <mainchain_block_hash> <elements_address> <value_sats> [fee_sats]` builds a sidechain transaction. Its input is an Elements **peg-in input** (`m_is_pegin`) whose peg-in witness is the drivechain variant (`IsDrivechainDepositPeginWitness`), validated by replaying parent blocks, not by a federation proof.
3. The credit transaction is "deterministic" and, with `fee_sats=0`, needs **no user signature**. Only optional fee-sponsoring wallet inputs get signed.
4. In practice the Sidechain Server (or anyone) can claim deposits. The user signs nothing on the Elements side.

**Withdrawal (Elements → eCash)**

1. The user signs an ordinary Elements transaction containing an **explicit pegged-asset burn output**: `OP_RETURN <parent genesis> <destination script> <8-byte fee>`, where burn = payout + parent fee.
   - rust-elements' `TxOut::pegout_data()` parses OP_RETURN + genesis + script and returns the remaining pushes, so a Decoder can show the destination and fee. The exact push order of the fee comes from the header comment and is not verified byte-for-byte.
2. After 6 Elements confirmations, `submitdrivechainwithdrawal` hands the deterministic blinded M6 to the enforcer. No user key is involved.
3. Payment depends on BIP300 miner votes and "may expire or fail", and the burn is irreversible.
4. LayerTwo's `fast-withdraw-server-go` exists for swap-style fast exits; whether it supports this chain was not checked.

**Consequence for Signing Requests.** On the sidechain, the only thing the user signs is a normal PSET. The new wallet-side work is:

- the **L1 M5 deposit** (L1 signer, low priority on the map);
- **clearly showing a burn output as "withdraw X to eCash address Y, irreversible, pays out after miner vote"**.

## 7. Reusable tooling and browser/WASM support

| Library | Version (date) | Fit |
|---|---|---|
| **rust-elements** (`elements` crate) | 0.27.0 (2026-08-04), actively maintained | Tx/PSET types, CT blinding/unblinding, address encoding with **custom `AddressParams`** (so `elements`/`elementsl` HRPs can be defined), Elements sighash, `pegout_data`. Pure Rust with secp256k1-zkp; builds to wasm32, as LWK shows. |
| **LWK** (`lwk_wollet`, `lwk_signer`, `lwk_common`, `lwk_simplicity`) | 0.19.0 (2026-08-18), master pushed 2026-10-16 | Descriptor wallet (CT descriptors, SLIP-77), PSET builder and signer, **`PsetDetails`** (per-asset balance change, fee, owned outputs, signatures: a ready-made Clear Signing base), Jade/Ledger signers. Supports **`Network::CustomElements(ElementsParams{policy_asset, genesis_hash, parent_genesis_hash})`**. |
| **lwk_wasm** (npm) | 0.19.0 (2026-08-18) | Browser bindings: `Network`, `Signer.sign(pset)`, `Wollet`, `TxBuilder`, `PsetDetails`, Esplora client, Jade over Web Serial. The README still calls it "only a proof of concept", though it backs liquidwebwallet.org. |
| liquidjs-lib (Vulpem) | 6.0.2-liquid.38 (2026-06-16); **repo archived** | Avoid for new work. |

**Caveats when pointing LWK at this chain:**

1. **Address prefixes.** For `CustomElements`, LWK always uses `AddressParams::ELEMENTS` (`ert`/`el`, `lwk_common/src/network.rs`), not the chain's `elements`/`elementsl`. The node accepts `ert`/`el` on input, but those prefixes "cannot distinguish this chain from Elements regtest" (`doc/lwk-address-compatibility.md`). To show users the chain's own prefixes, re-encode with rust-elements custom `AddressParams` or patch LWK.
2. **Genesis hash.** `lwk_wasm`'s `Network.regtest(policyAsset)` sets *only* the policy asset; the genesis hash stays at Liquid regtest's default. That is wrong for taproot sighash. Fix it either by including the ELIP-101 genesis field in every PSET, or by exposing `ElementsParamsBuilder.with_genesis_hash` in a small wasm wrapper.
3. **Peg-in inputs.** LWK refuses PSETs where an owned input is a peg-in (`Error::InputPeginUnsupported`, `lwk_common/src/lib.rs`). This does not matter much, because deposit credits need no user signature.
4. **Indexer and accounting.** Syncing needs the drivechain-aware electrs/Esplora. The node docs warn that a stock backend can't parse the headers and that "stock LWK's explicit-output accounting" isn't fixed: "use the matching SDK and indexer". That SDK is not published anywhere I could find. This matches the map's v0 stance of trusting Sidechain-Server state.

## Open uncertainties

- **Mainnet status.** There is no announced mainnet slot, identity or release; the current code is a "Betanet test profile". A wallet must not hardcode identity values. Will it activate on mainnet at all, and when?
- **Header extension.** Does the current native network's block header still differ from stock Elements? The BMM-proof doc says the old extension is "historical"; the explorer docs say electrs needs a fork. This matters for any light-client verification later.
- **Explicit-output accounting.** What exactly is "stock LWK's explicit-output accounting" issue, and does it affect balances shown by `lwk_wasm`?
- **Withdrawal script bytes.** The exact byte layout of the withdrawal OP_RETURN (fee push order and endianness) should be confirmed against `src/haskell/` or test vectors before writing a Decoder.
- **Taproot vs v0.** Does the network expect wallets to use segwit v0 (`wpkh`) or taproot by default? LayerTwo's client requests `bech32` (v0) addresses.

## Sources

- ecash.com home and /sidechains, fetched 2026-10-19
- freewillydev/liquid-drivechain-signet-adaptation @ `efce6b2f` (2026-10-18):
  - `README.md`
  - `doc/drivechain-peg-operations.md`, `doc/lwk-address-compatibility.md`, `doc/drivechain-bmm-proof.md`, `doc/elements-confidential-transactions.md`, `doc/pset.mediawiki`, `doc/taproot-sighash.mediawiki`
  - `src/elements_drivechain_identity.h`, `src/kernel/chainparams.cpp`, `src/pegins.cpp`, `src/drivechain_withdrawal.{h,cpp}`, `src/wallet/rpc/elements.cpp`
  - commit log and release list
- LayerTwo-Labs/drivechain-frontends (main, 2026-10): `sidechain-orchestrator/chains_config.json`, `sidechain-orchestrator/sidechain/elements/node.go`, `liquid-signet-integration.md`
- freewillydev/esplora-liquid-drivechain `README.md`, `RUNNING_WITH_ELEMENTS.md`; freewillydev/USDD `README.md`
- Blockstream/lwk @ `8e891aa4` (2026-10-16): `lwk_common/src/network.rs`, `lwk_common/src/pset.rs`, `lwk_common/src/lib.rs`, `lwk_signer/src/software.rs`, `lwk_wasm/src/{network,signer,pset_details}.rs`, `lwk_wasm/README.md`
- ElementsProject/rust-elements master (2026-10-17): `src/transaction/mod.rs` (`pegout_data`)
- ElementsProject/ELIPs: ELIP-101 (genesis hash in PSET), ELIP-150/151 (CT descriptors)
- crates.io and npm registry metadata, fetched 2026-10-19
- Blockstream Liquid docs, technical overview: https://docs.liquid.net/docs/technical-overview
