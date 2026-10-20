# eCash L1 and drivechain mechanics

Research for [#2](https://github.com/marcusmmmz/ecx-wallet/issues/2), map [#1](https://github.com/marcusmmmz/ecx-wallet/issues/1).
Researched **2026-10-19**, twelve days before the planned mainnet fork. Many of these parameters changed between the test stages and some are still changing, so the date of each source matters. Re-check the items marked **[moving]** before building on them.

## Question

What is the current state of eCash (ECX): launch status, node software, and how BIP300/BIP301 drivechains work on it? Specifically: how a deposit to and a withdrawal from a sidechain happen on L1, what L1 transactions the user's wallet must build or sign for each, and what node/indexer/RPC APIs a browser wallet could use to read L1 state.

## Short answer

- eCash is a hard fork of Bitcoin by LayerTwo Labs. The node is Bitcoin Core v31.1 plus a small set of patches. Mainnet forks at height **973,728**, around **2026-10-31 15:00 UTC**, and has **not launched yet**. Betanet is the live rehearsal chain.
- Keys and addresses are byte-for-byte Bitcoin. An L1 transaction is a normal Bitcoin transaction with one difference: to be replay-protected it must carry a magic `nLockTime`, and that value is **different on mainnet** from the test networks.
- **Deposit (L1 to L2)** is one L1 transaction, called an M5. The user signs it. It spends the user's own coins plus the sidechain's anyone-can-spend treasury UTXO (the "CTIP"), and it outputs a larger treasury UTXO followed immediately by `OP_RETURN <sidechain address>`. Building it requires knowing the current CTIP. Only the BIP300 enforcer daemon serves the CTIP; a plain Esplora server does not.
- **Withdrawal (L2 to L1): the user signs nothing on L1.** The user signs a sidechain withdrawal that names an L1 address and an L1 fee. The sidechain batches withdrawals into a bundle (M3). Miners ACK it for months (M4: 13,150 ACKs within 26,300 blocks). Miners then construct the payout transaction (M6), which needs no signature. The fast path is a fast-withdrawal server that pays the user on L1 from its own wallet, against an L2 payment.
- **Reading L1 from a browser:** Esplora REST and the mempool.space API are public and send `Access-Control-Allow-Origin: *`. Electrum is TCP/TLS only, which browsers cannot open. Drivechain state (CTIPs, sidechains, deposits, bundle votes) comes only from the enforcer's Connect RPC (HTTP/JSON). No public endpoint or CORS support for it was found.

## 1. Launch status (as of 2026-10-19)

| Stage | Fork height | Date | Status |
|---|---|---|---|
| alphanet | 963,648 | 2026-08-23 | retired 2026-09-24 |
| betanet | 967,680 (hash `00000000000000030101ba5cfea54b22becc79f95dc6040beb76e01dd9d04042`) | 2026-09-19 | live; tip was 973,864 when checked |
| **mainnet** | **973,728** | **~2026-10-31 15:00 UTC** | pending |

- Each stage is a fresh fork from Bitcoin. Alpha and beta coins are not mainnet coins ([electrum-ecash README](https://github.com/ecash-com/electrum-ecash)). At mainnet, every BTC UTXO is credited ECX 1:1 with no claim step ([ecash.com](https://ecash.com/), fetched 2026-10-19).
- Seven LayerTwo Labs sidechains are planned: BitNames (slot 2), BitAssets (4), Thunder (9), Truthcoin (13), zSide (98), Photon (99), CoinShift (255) ([fast-facts/05](https://github.com/ecash-com/fast-facts/blob/main/05-sidechains-and-l2s.md), 2026-09-22).
- Betanet also has **community** sidechains: FreeBank (slot 130), **Elements (slot 24)**, and Solana (slot 8), each activated with 1,009 ACKs ([beta.ecash.ninja](https://beta.ecash.ninja), fetched 2026-10-19). An "Elements" drivechain is relevant to this map's first-sidechain decision, but this research did not find its maintainers or code.
- Consensus quirk: hard-coded "repurpose" transactions move Satoshi-era (Patoshi) coins without signatures (ecash.com; [the-satoshi-coins](https://github.com/ecash-com/the-satoshi-coins)). This does not matter to a wallet, beyond the fact that those coins are valid ECX.

## 2. Node software

**Source:** [`ecash-com/bitcoin`](https://github.com/ecash-com/bitcoin), `master` branch (README and `src/kernel/chainparams.cpp`, last ecash commit 2026-09-09). Earlier stages live on their own branches (`alphanet`, `betanet`, `drynet1-4`). Binaries are at <https://releases.ecash.com> and can be verified with `gh attestation verify`.

The patch stack on top of Bitcoin Core v31.1 (from the `master` commit log):

| Patch | Mainnet value (`master`) | Notes / differs from older docs |
|---|---|---|
| Fork height (`EcashHeight`) | 973,728, with a one-time difficulty reset to `0x1901a6e1` | |
| Network magic | `0xeca5dcb7` | drynets reused Bitcoin's `f9beb4d9`; alphanet used `eca5a104`, betanet `eca5b104` |
| Ports | P2P **8533**, RPC **8532** | older integration guide said 8333/8332 |
| Datadir / config | `~/.ecash`, `ecash.conf` | |
| DNS seeds | `seed.ecash.ninja`, `seed.bip300.xyz`, `seed.ecash.drivecha.in`, `seed.ecash.zuexeuz.net`, `seed.ecash.eu.com` | |
| Address/key prefixes | identical to Bitcoin mainnet (P2PKH 0x00, P2SH 0x05, bech32 `bc`, WIF 0x80, xpub/xprv) | |
| `OP_DRIVECHAIN` | **`OP_NOP8` (0xb7)** **[moving]** | BIP300 and alphanet use `OP_NOP5` (0xb4); betanet and `master` use NOP8 |
| Replay protection | **`nLockTime == 499999998`** (`LOCKTIME_THRESHOLD - 2`) **[moving]** | alphanet/betanet/drynet3 use `499999999`; drynet1/2 used a magic tx version |
| OP_RETURN limits | removed | |
| `getblocktemplate` | works without peers or IBD; adds a bip300301 rule | |
| RPC | `getblockchaininfo` still reports `chain=main`, and amounts show as "BTC" | |

Sources: the `master` README; commits [`121790c`](https://github.com/ecash-com/bitcoin/commit/121790ca7) (OP_DRIVECHAIN as NOP8) and [`b9df0c5`](https://github.com/ecash-com/bitcoin/commit/b9df0c5fe) (replay `LOCKTIME_THRESHOLD - 2`); `src/consensus/tx_verify.cpp` on `master`, compared with the `betanet` and `drynet3` branches; and [fast-facts/03](https://github.com/ecash-com/fast-facts/blob/main/03-replay-protection-and-coin-splitting.md), updated 2026-10-19, which warns that the magic value differs per network.

**BIP300/301 rules are not in the node.** The node carries only the plumbing: making `OP_DRIVECHAIN` standard and lifting the OP_RETURN limits. The BIP300/301 state machine runs in a separate daemon, [`LayerTwo-Labs/bip300301_enforcer`](https://github.com/LayerTwo-Labs/bip300301_enforcer) (Rust). It sits beside a non-pruned node over RPC and ZMQ, and serves Connect RPC on port 50051 ([fast-facts/05](https://github.com/ecash-com/fast-facts/blob/main/05-sidechains-and-l2s.md); enforcer README). **[moving]** As of 2026-10-19, the enforcer's `master` has presets for alphanet and betanet only. eCash-mainnet support, which adds `--fork ecash` and sets the replay `nLockTime` on wallet sends and deposits, is still the open [PR #666](https://github.com/LayerTwo-Labs/bip300301_enforcer/pull/666).

### Replay protection, in practice for our wallet

- A transaction is replay-protected only if it sets `nLockTime` to the network's magic value **and** has at least one input with `nSequence < 0xffffffff`. Otherwise locktime is ignored, and Bitcoin would accept the transaction ([fast-facts/03](https://github.com/ecash-com/fast-facts/blob/main/03-replay-protection-and-coin-splitting.md); PR #666 test asserts "has only final inputs, so Bitcoin ignores its nLockTime").
- Protection is opt-in and one-directional: it stops ECX transactions from being replayed on Bitcoin. A Bitcoin transaction spending a pre-fork UTXO can still be replayed onto ECX. The defence is to "split": spend pre-fork coins on ECX first ([fast-facts/03](https://github.com/ecash-com/fast-facts/blob/main/03-replay-protection-and-coin-splitting.md)). Since the same seed controls BTC, the Wallet Base needs a split flow, or at least must always set the marker. BitWindow does an automatic one-time split.
- Make the magic value a **per-network constant**. The value tested on betanet is wrong for mainnet.
- An M5 deposit that spends a CTIP cannot be replayed on Bitcoin anyway, because the CTIP does not exist there. The marker is still harmless, and PR #666 sets it on deposits too.

## 3. Deposit (L1 to L2): the M5 transaction

Sources: [LayerTwo-Labs/bip300_bip301_specifications `bip300.md`](https://github.com/LayerTwo-Labs/bip300_bip301_specifications/blob/master/bip300.md) (2026-08-13); [BIP300](https://github.com/bitcoin/bips/blob/master/bip-0300.mediawiki) (Status: Draft); and the enforcer's `lib/wallet/mod.rs` (`create_deposit`, `create_deposit_psbt`) and `lib/types.rs` (`OpDrivechain`) on `master`, 2026-10-19.

Each active sidechain slot `S` has **exactly one** treasury UTXO, the **CTIP**. It holds every coin in circulation on that sidechain. Its script is anyone-can-spend, and only consensus rules guard it:

```
scriptPubKey = OP_DRIVECHAIN 0x01 <S> OP_TRUE        # 4 bytes; OP_DRIVECHAIN = 0xb7 on betanet/mainnet-master, 0xb4 per BIP300
```

A valid M5 deposit of `V` sats to sidechain address `A`:

| Part | Content |
|---|---|
| input: previous CTIP | the current CTIP outpoint for slot `S`, with an **empty scriptSig and no witness** (`final_script_sig = ""`). Omitted only for the very first deposit to a slot |
| input(s): user funds | normal P2WPKH/P2TR and other UTXOs, signed by the user |
| output `i`: new CTIP | `OP_DRIVECHAIN <S> OP_TRUE`, value = `old_CTIP_value + V` |
| output `i+1`: address | `OP_RETURN <A>`, which **must come immediately after** the new CTIP. `A` is opaque bytes whose meaning the sidechain defines. The enforcer's `CreateDepositTransaction` uses the UTF-8 bytes of the sidechain address string |
| other outputs | change, etc. The enforcer puts the CTIP and OP_RETURN pair first and orders everything else randomly |
| `nLockTime` | the network's replay magic (PR #666), with a non-final `nSequence` |

What this means for the Wallet Base:

- **It needs the current CTIP** (txid, vout, value, sequence number) for the target slot. The source is the enforcer's `ValidatorService/GetCtip`. A plain Esplora server cannot pick out the CTIP: you could scan for the script, but only the enforcer knows which output is the valid current one. It also needs the full previous transaction if it signs the CTIP input in legacy style; that transaction is fetchable from Esplora (`/tx/:txid/hex`).
- **Signing:** only the user's own inputs. The CTIP input carries no signature. Under SIGHASH_ALL the user's signatures commit to the CTIP outpoint and to the exact new-CTIP value, so a PSBT works fine, and the wallet can Clear Sign it: "deposit V to slot S, address A".
- **Contention:** every deposit to a slot spends the same CTIP, so two wallets that build from the same CTIP conflict, and only one confirms. The enforcer can chain deposits through the mempool, and there is an open enforcer fix to evict losing competing M5s ([PR #607](https://github.com/LayerTwo-Labs/bip300301_enforcer/pull/607)). **[moving]** The open [PR #664 "Aggregate M5 deposits"](https://github.com/LayerTwo-Labs/bip300301_enforcer/pull/664) adds "unconsolidated ctips", which the block producer consolidates with its own M5. If it merges, a deposit may no longer need to spend the CTIP. Whatever builds deposits should sit behind one seam, because the format may change.
- **Deposit address format:** sidechains show a "deposit address" `s<SLOT>_<ADDRESS>_<CHECKSUM>`, where CHECKSUM is the hex of the first 6 bytes of `SHA256("s<SLOT>_<ADDRESS>")`. Only the middle `<ADDRESS>` goes into the OP_RETURN (`wallet.proto`, `CreateDepositTransactionRequest`; Thunder's `format_deposit_address` RPC).
- **The node must accept it:** `OP_DRIVECHAIN` outputs are standard on the eCash node (`master`), so broadcasting through Esplora `POST /tx` should work. The enforcer also broadcasts over P2P as "nonstandard", as a fallback.
- **Today's reference flow** is BitWindow, or a sidechain's `create_deposit` RPC (Thunder: `create_deposit(address, value_sats, fee_sats)`). Both delegate to the enforcer's **own** BDK wallet (`WalletService/CreateDepositTransaction`). That means the enforcer holds the L1 keys. Our Wallet Base would have to build the M5 itself, or receive it as a PSBT (for example from a Sidechain Server) and sign only its own inputs. No enforcer RPC was found that returns an *unsigned* deposit PSBT for an external wallet.
- The sidechain credits the deposit once its node sees the M5 through the enforcer's `GetTwoWayPegData` / `SubscribeEvents` (`Deposit{sequence_number, outpoint, output{address, value_sats}}`).

## 4. Withdrawal (L2 to L1): M3, M4, M6

Sources: the [`bip300.md` spec](https://github.com/LayerTwo-Labs/bip300_bip301_specifications/blob/master/bip300.md) (M3/M4/M6, constants), enforcer `lib/types.rs` (`Thresholds::MAINNET`/`BETANET`), [fast-facts/05](https://github.com/ecash-com/fast-facts/blob/main/05-sidechains-and-l2s.md), [thunder-rust `rpc-api/lib.rs`](https://github.com/LayerTwo-Labs/thunder-rust/blob/master/rpc-api/lib.rs), and the open enforcer PR #664's block-producer notes.

1. **On L2 (the user signs this):** a sidechain withdrawal transaction that names an L1 address, an amount, the L2 fee, and a **mainchain fee**. Thunder: `withdraw(mainchain_address, amount_sats, fee_sats, mainchain_fee_sats)`. Its signature scheme is the sidechain's own, not L1's.
2. **Bundling (sidechain):** the sidechain gathers pending withdrawals into a bundle (up to 6,000 per bundle), which describes an M6 transaction. The bundle is identified by its **M6ID**, the txid of a "blinded" M6: no input, and the CTIP output replaced by `OP_RETURN <8-byte big-endian total fee>`.
3. **M3, propose bundle (coinbase):** the sidechain hands the bundle to the enforcer (`WalletService/BroadcastWithdrawalBundle`), and a miner commits to its M6ID in a coinbase.
4. **M4, ACK bundle (coinbase):** miners vote. Payout needs **more than 13,150 ACKs within 26,300 blocks** of the proposal, about 3 to 6 months. These are the mainnet values, and betanet runs them unchanged (alphanet used 72 ACKs within 144 blocks). Bundle status is visible through `ValidatorService/GetWithdrawalBundleProposals` (m6id, vote_count, proposal_height) and the sidechain's `get_withdrawal_bundle` / `pending_withdrawal_bundle` RPCs.
5. **M6, payout (a regular L1 transaction):** exactly one input, the CTIP. The outputs are the payouts plus a new CTIP worth `old − payouts − fees`. **It is constructed, never signed:** the block producer adds it to the block once the M6ID passes the threshold ("an M6 is constructed, never signed", PR #664). If the bundle expires, it fails and the sidechain refunds the withdrawals on L2.
   - Spec inconsistency: `bip300.md` says the new CTIP is at `vout[0]` in one place and is the last output in another. This matters only to anyone decoding M6s.

**What the Wallet Base must build or sign on L1 for a withdrawal: nothing.** It only supplies an L1 receive address, and then watches that address via Esplora for the payout. The L1 part of the UX is "pending for months, then a payment arrives".

**Fast withdrawals** are the practical path. A [fast-withdrawal server](https://github.com/LayerTwo-Labs/fast-withdraw-server-go) (custodial, so you trust the operator) works like this: `CreateWithdrawal` returns an Ed25519-signed quote with the L2 address, L2 sats, L1 address, L1 sats, fee, and expiry. The user then pays the L2 address with an ordinary sidechain transfer and calls `SubmitPayment`. The operator sends L1 coins from its own wallet; poll `GetWithdrawal` until it reads `PAID`. Here too the user signs only on L2. There is a Connect RPC API defined in `proto/fastwithdraw/v1/fastwithdraw.proto`.

## 5. BIP301 (blind merged mining), briefly

Sidechain block producers pay L1 miners in ECX to commit a sidechain block hash (`h*`) in the L1 coinbase. The payment is an "M8"/BMM request transaction whose fee is the bid (`ValidatorService/GetSeenBmmRequests`; `WalletService/CreateBmmCriticalDataTransaction`). This is block-producer work, so **a user wallet never builds BIP301 transactions** ([`bip301.md`](https://github.com/LayerTwo-Labs/bip300_bip301_specifications/blob/master/bip301.md); fast-facts/05).

## 6. APIs a browser wallet can use to read L1

| Need | Source | Browser-usable? |
|---|---|---|
| Balances, UTXOs, history, tx hex, fee estimates, broadcast | **Esplora REST**: betanet `https://esplora.beta.ecash.ninja` ([API ref](https://github.com/Blockstream/esplora/blob/master/API.md)) | **Yes.** Sends `Access-Control-Allow-Origin: *` (checked 2026-10-19) |
| Same, plus mempool.space extras (`/api/v1/difficulty-adjustment`, fees) | **mempool.space API**: `https://explorer.beta.ecash.ninja/api/` ([ecash-com/mempool](https://github.com/ecash-com/mempool)) | **Yes.** CORS `*` (checked 2026-10-19) |
| Electrum protocol | Fulcrum at `ssl://explorer.beta.ecash.ninja:50002` | **No.** Raw TCP/TLS. Would need a WebSocket endpoint, and none was found |
| Trezor-style xpub balance backend | [ecash-com/blockbook](https://github.com/ecash-com/blockbook) fork | Possibly. No public instance found |
| CTIP per slot, active sidechains, proposals, deposits per block, bundle votes, event stream | **Enforcer Connect RPC** (`cusf.mainchain.v1.ValidatorService`: `GetCtip`, `GetSidechains`, `GetSidechainProposals`, `GetTwoWayPegData`, `GetWithdrawalBundleProposals`, `SubscribeEvents`, `GetChainTip`), [protos](https://github.com/LayerTwo-Labs/bip300301_enforcer/tree/master/proto/cusf/mainchain/v1) | **The protocol works in a browser** (Connect = HTTP POST with JSON, usable from `@connectrpc/connect-web`). **But** no public instance was found, and no CORS layer was found in the server code, so it would need a proxy we run or a Sidechain Server to relay it |
| Full node | Bitcoin Core RPC/REST/ZMQ on the eCash node | No. Not for browsers directly |

- **Mainnet hostnames are not published yet.** `explorer.ecash.com` currently redirects to the betanet explorer, and the docs say to "expect new hostnames again at mainnet" (fast-facts/04).
- `explorer.ecash.com`, `dashboard.ecash.com`, and the hub at `beta.ecash.ninja` are the official entry points. The hub's page runs enforcer RPCs, so some enforcer instance exists behind it, but its address was not documented.
- Library choice: any Bitcoin library builds valid ECX transactions with Bitcoin-mainnet settings: bitcoinjs-lib, BDK (Rust→WASM), libwally, and others. There is no separate SLIP-44 coin type, so the coin type is `0'` (fast-facts/02; electrum-ecash README). LayerTwo's own mobile wallet uses BDK.

## Open uncertainties

1. **Final mainnet parameters are not settled.** The replay `nLockTime` (`499999998` on `master`, against `499999999` in older docs) and `OP_DRIVECHAIN` (NOP8 on `master`, against NOP5 in BIP300 and some docs) both come from `ecash-com/bitcoin` `master`, which carries no release tag yet. Enforcer mainnet support is the unmerged PR #666. Re-verify against the mainnet release around 2026-10-31.
2. **The M5 format may change** if PR #664 ("Aggregate M5 deposits", unconsolidated CTIPs) merges.
3. **No public enforcer endpoint and no CORS.** Who serves CTIP and drivechain state to a browser wallet? It could be our own proxy, each Sidechain Server, or an official public instance.
4. **No unsigned-deposit-PSBT RPC** was found for external wallets. Every reference flow uses the enforcer's internal wallet.
5. **Mainnet public infrastructure** (Esplora, Electrum, explorer hostnames) is not yet announced.
6. **The community "Elements" sidechain (betanet slot 24)**: its maintainers, code, and whether it is the Elements drivechain this map targets, were not found.
7. No Electrum-over-WebSocket server was found. The two browser-friendly indexers are Esplora and mempool.space.

## Sources (all fetched 2026-10-19)

- ecash.com home page: stage dates and heights.
- [ecash-com/fast-facts](https://github.com/ecash-com/fast-facts): the official integration guide. README dated 2026-09-22 (betanet); replay page updated 2026-10-19.
- [ecash-com/ecash-integration](https://github.com/ecash-com/ecash-integration): the older guide (drynet3, 2026-07-27). It is superseded, and was used only to trace how parameters changed.
- [ecash-com/bitcoin](https://github.com/ecash-com/bitcoin): `master`, `betanet`, and `drynet3` branches, chainparams, `tx_verify.cpp`, and commits.
- [LayerTwo-Labs/bip300301_enforcer](https://github.com/LayerTwo-Labs/bip300301_enforcer): `master` (README, `lib/types.rs`, `lib/wallet/mod.rs`, protos) and PRs #607, #664, #666.
- [LayerTwo-Labs/bip300_bip301_specifications](https://github.com/LayerTwo-Labs/bip300_bip301_specifications), and [BIP300](https://github.com/bitcoin/bips/blob/master/bip-0300.mediawiki) / [BIP301](https://github.com/bitcoin/bips/blob/master/bip-0301.mediawiki).
- [LayerTwo-Labs/thunder-rust](https://github.com/LayerTwo-Labs/thunder-rust) RPC API; [LayerTwo-Labs/fast-withdraw-server-go](https://github.com/LayerTwo-Labs/fast-withdraw-server-go).
- [beta.ecash.ninja](https://beta.ecash.ninja) hub; live CORS and API probes of `esplora.beta.ecash.ninja` and `explorer.beta.ecash.ninja`.
- [drivechain.info/dev.txt](https://drivechain.info/dev.txt): stale (dated 2026-02-19, signet era); used only for the slot and port table.
