# Prior art: wallet-signer protocols and Clear Signing

Research for [#5](https://github.com/marcusmmmz/ecx-wallet/issues/5), on the map [#1](https://github.com/marcusmmmz/ecx-wallet/issues/1). Researched 2026-10-19.

**Question:** What can the **Signing Request** protocol borrow from existing wallet-signer protocols? For each protocol: transport, envelope shape, versioning, how display metadata is attached and how it's trusted, and lessons from blind-signing incidents.

Terms in bold are from [GLOSSARY.md](../GLOSSARY.md).

## TL;DR

- Every mature protocol splits things the same way. The party that **builds** a payload (dapp, PSBT Creator/Updater, our **Sidechain Server**) is treated as untrusted. The party that **signs** has to check the payload's meaning itself, from the bytes it is about to sign.
- Display metadata is trusted only when it is **bound** to the exact payload (contract address, chain ID, selector, schema hash) **and** comes from a source the signer already trusts: Ledger-signed descriptors, ERC-7730 binding constraints, a BIP-388 policy the user approved on the device. Labels the builder sends along unbound are hints and nothing more.
- The two biggest blind-signing losses, Bybit (Feb 2025, about $1.4–1.5B) and Radiant (Oct 2024, about $50M), happened the same way. The *building/display* layer was compromised, so the UI showed one transaction while the signers signed another. Simulation and multisig did not save them. Clear Signing on the signer, decoded from the signed bytes, would have.
- Versioning precedent is strict. PSBT says a parser "should exit immediately" on an unknown version. ERC-7730 says a wallet "MUST consider a descriptor invalid" if it doesn't implement the MAJOR version. Unknown *fields* inside a known version are passed through, not dropped (PSBT).
- For the first sidechain (Elements), the chain-native payload already exists: **PSET** (PSBTv2 + Elements fields). The Signing Request should carry it as-is, not reinvent it.

## 1. PSBT (BIP 174) and PSBTv2 (BIP 370)

Sources: [BIP 174](https://github.com/bitcoin/bips/blob/master/bip-0174.mediawiki), [BIP 370](https://github.com/bitcoin/bips/blob/master/bip-0370.mediawiki).

- **Transport:** none. PSBT is a file/blob format, binary or Base64 (RFC 4648), moved by USB, QR, SD card or anything else. Transport-agnostic by design.
- **Envelope shape:** magic `psbt` + `0xFF`, then one global map, one map per input and one per output. Each map is a list of `<keylen><keytype><keydata> <valuelen><value>` entries ending in `0x00`. Keys are unique within a map.
- **Roles:** Creator, Updater, Signer, Combiner, Input Finalizer, Transaction Extractor (BIP 174). BIP 370 adds the **Constructor**, which may add inputs and outputs only while the `PSBT_GLOBAL_TX_MODIFIABLE` flags allow it. A signature without `ANYONECANPAY` clears "Inputs Modifiable", and one without `SIGHASH_NONE` clears "Outputs Modifiable" (BIP 370). The role split maps cleanly onto ours: the **Sidechain Server** is Creator/Updater/Constructor, and the **Wallet Base** is Signer.
- **Versioning:** `PSBT_GLOBAL_VERSION` (0xFB). It is absent or 0 for v0 and must be 2 for v2. BIP 174: a parser that meets an unrecognized version "should exit immediately". BIP 370: "PSBTv2 is incompatible with PSBTv0, and vice versa."
- **Extensibility:** proprietary keytype `0xFC` (identifier prefix + subtype) in every map. Unknown keys: the signer "must pass those key-value pairs through when re-serializing the transaction" (BIP 174).
- **Display metadata and trust:** none in the human-readable sense. The metadata is *verifiable data*, not labels:
  - Full previous transactions (`NON_WITNESS_UTXO`), so the signer can check input amounts: "its hash must match the hash specified in the prevout".
  - Scripts, which must match the scriptPubKey.
  - BIP32 derivation paths on outputs, so the signer can **derive and compare** to recognize its own change instead of trusting a "this is change" label.
  - "If a sighash type is provided, the signer must check that the sighash is acceptable. If unacceptable, they must fail."
- **Lesson:** trust comes from recomputation. Every hint the Updater adds is something the signer can check against the bytes it signs.

## 2. PSET (Elements)

Source: [Elements `doc/pset.mediawiki`](https://github.com/ElementsProject/elements/blob/master/doc/pset.mediawiki).

- PSBTv2 with magic `0x70736574` (`pset`). Elements fields live in proprietary keys with the `pset` identifier prefix and are "only allowed when the PSBT version is 2".
- Adds confidential-transaction fields (value/asset commitments, rangeproofs, surjection proofs, blinding pubkeys, ECDH keys), issuance fields, peg-in fields (peg-in tx, txout proof, claim script, genesis hash), and explicit value/asset fields with **blind value/asset proofs**.
- Adds a **Blinder** role. Signer rule: "Before signing, the Signer must check whether blinding is complete". It must not sign if an output has a blinding pubkey but no commitments or proofs.
- **Trust for display:** amounts and assets in a confidential transaction are commitments. The signer can show a real amount only if it unblinds with its own keys or checks an explicit value against its proof. The spec has no complete "verify amounts for display" procedure, so a Decoder has to define one.
- **Relevance:** the first sidechain is an Elements drivechain. A PSET Decoder is the obvious first Clear Signing target. Peg-in/peg-out fields in PSET are Elements' own federated-peg fields, which may not match drivechain deposit/withdrawal semantics (open question).

## 3. BIP-388 wallet policies

Source: [BIP 388](https://github.com/bitcoin/bips/blob/master/bip-0388.mediawiki).

- **Problem solved:** a hardware signer has to know *which script policy* controls the funds, including change, to tell "my change" from "an attacker's output". The host is treated as untrusted. "The ability for the user to completely validate on-screen the kind of script used" is crucial.
- **Shape:** a descriptor template with key placeholders (`wsh(sortedmulti(2,@0/**,@1/**))`) plus a key-information vector (`[fingerprint/path]xpub`). `/**` means `/<0;1>/*` (receive/change).
- **Trust model: register once, then reference.**
  1. The host sends the policy plus a name.
  2. The device shows it on its secure screen.
  3. The user checks it against a trusted backup and approves.
  4. The device stores it, or returns a **proof of registration** (the BIP suggests an HMAC over the policy, name and metadata).

  After that, the policy name alone is enough on screen, and change outputs are checked against the registered policy.
- **Lesson:** expensive human verification happens **once**, at a trust-establishing moment, and leaves a signer-held record (stored, or MAC'd by the signer's own key). Later requests are checked against that record automatically. The same pattern fits "approve this Sidechain Server / this Decoder once" in the Wallet Base.

## 4. EIP-1193 (provider API)

Source: [EIP-1193](https://eips.ethereum.org/EIPS/eip-1193).

- **Transport:** a JavaScript object the wallet injects into the page. It is "transport- and protocol-agnostic".
- **Envelope:** `request({ method: string, params?: unknown[] | object }): Promise<unknown>`. It is JSON-RPC shaped but not literally JSON-RPC.
- **Events:** `connect`, `disconnect`, `chainChanged`, `accountsChanged`, `message`.
- **Errors (a useful precedent to copy):**

  | Code | Meaning |
  |---|---|
  | 4001 | User Rejected Request |
  | 4100 | Unauthorized (method/account not authorized by user) |
  | 4200 | Unsupported Method |
  | 4900 | Disconnected |
  | 4901 | Chain Disconnected |

- **Versioning:** none in the envelope. Methods are named strings, and new capability means new method names.
- **Display metadata:** none. Display is entirely the wallet's job.
- **Notes:** accounts must not be exposed by default (explicit `eth_requestAccounts` / `wallet_requestPermissions`). The spec says the provider object should be treated as untrusted because any page script can tamper with it.

## 5. EIP-712 (typed structured data)

Source: [EIP-712](https://eips.ethereum.org/EIPS/eip-712).

- **Motivation:** "signed messages are an opaque hex string displayed to the user with little context".
- **Envelope:** `{types, primaryType, domain, message}` JSON. The signature is over `0x1901 ‖ domainSeparator ‖ hashStruct(message)`. The `0x19` prefix (ERC-191) means a typed-data signature can never be a valid transaction or plain-message signature (**domain separation by prefix**).
- **Domain:** `name`, `version`, `chainId`, `verifyingContract`, `salt`. On `chainId`: "The user-agent *should* refuse signing if it does not match the currently active chain." The domain lets wallets "inform/warn users or refuse signing".
- **Versioning:** `version` in the domain is the signing domain's major version, i.e. the app's, not the envelope's.
- **Display metadata:** the type names and field names are the only labels, and they come from the requester. They are structured but not trusted.
- **Limits:**
  - The spec "does not include replay protection". Applications must handle repeats and front-running themselves.
  - It doesn't help render nested operations. The Bybit payload was a valid, structured EIP-712 Safe message whose meaning (`operation=1`, delegatecall) was still lost on humans (see §8).

## 6. WalletConnect v2 (Sign API)

Sources: [Sign API](https://specs.walletconnect.com/2.0/specs/clients/sign/), [RPC methods](https://specs.walletconnect.com/2.0/specs/clients/sign/rpc-methods), [Namespaces](https://specs.walletconnect.com/2.0/specs/clients/sign/namespaces), [Crypto envelopes](https://specs.walletconnect.com/2.0/specs/clients/core/crypto/crypto-envelopes), [Verify server](https://specs.walletconnect.com/2.0/specs/servers/verify/), [Verify server API](https://specs.walletconnect.com/2.0/specs/servers/verify/verify-server-api).

- **Transport:** an untrusted relay (websocket) between dapp and wallet. Pairing via URI/QR. Messages are end-to-end encrypted with ChaCha20-Poly1305. Envelope type 0 is `type ‖ iv ‖ sealbox` (shared symmetric key). Type 1 adds the sender's 32-byte public key for Diffie-Hellman key agreement. The first byte always names the envelope type.
- **Session negotiation (a model for per-server permissions):**
  - `wc_sessionPropose` carries `requiredNamespaces` keyed by namespace (e.g. `eip155`), each with `chains` (CAIP-2, `namespace:reference`), `methods` and `events`.
  - The wallet answers with `wc_sessionSettle` listing `accounts` (CAIP-10, `chain:reference:address`) and the granted methods/events, plus an `expiry`.
  - "All required namespaces MUST be satisfied by a wallet." The wallet may grant more, "never less".
  - Error codes: 5000–5104 (namespaces/chains/methods rejected), 1006 (invalid proposal).
- **Request envelope:** `wc_sessionRequest` = `{ request: { method, params, expiry? }, chainId }`. `expiry` must fall between now+300 s and now+7 days. Each RPC has a fixed TTL and tag.
- **Versioning:** at the protocol level (v1 → v2 broke pairing/session coupling). Per-request capability is negotiated through method names in namespaces.
- **Display metadata and trust:** the proposer sends `metadata` (name, url, icons). It is self-asserted. WalletConnect added the **Verify** server to "authenticate the origin of an attestation id which is related to a JSON-RPC payload": the dapp registers `{attestationId, origin}` and the wallet resolves `attestationId → origin`. *Not confirmed from the spec pages read:* how `attestationId` is derived (SDK docs say a hash of the request) and the wallet-facing statuses (VALID / INVALID / UNKNOWN, `isScam`).
- **Lesson:** self-reported requester identity is spoofable. If identity matters, it has to be attested out of band, and the wallet must show when it isn't.

## 7. ERC-7730 and Ledger Clear Signing

Sources: [ERC-7730](https://eips.ethereum.org/EIPS/eip-7730), [Ledger Clear Signing overview](https://developers.ledger.com/docs/clear-signing/overview), [How it works](https://developers.ledger.com/docs/clear-signing/understanding/how-does-it-work), [For wallets](https://developers.ledger.com/docs/clear-signing/for-wallets), [Submission process](https://developers.ledger.com/docs/clear-signing/erc7730/process), [Ledger Ethereum app APDU doc](https://github.com/LedgerHQ/app-ethereum/blob/master/doc/apdu.md), [GCS flow](https://github.com/LedgerHQ/app-ethereum/blob/master/doc/gcs.md), [EIP-712 filtering](https://github.com/LedgerHQ/app-ethereum/blob/master/doc/eip712.md).

**ERC-7730**

- **What it is:** a JSON *descriptor* format, separate from the payload, that tells a wallet how to render a contract call or an EIP-712 message. Status: Draft ERC. Schema 2.1.0 is active, and 1.0.0 is deprecated.
- **Shape:**
  - `$schema`
  - `context`, the binding: `contract.deployments` = `[{chainId, address}]`, or `eip712.domain` / `eip712.deployments` / `domainSeparator`.
  - `metadata`: owner, token info, enums, constants. It "can be trusted when the ERC-7730 file is applicable for the given context".
  - `display.formats` per selector or message type, with `intent`, `interpolatedIntent` and `fields[]`. Each field has a `path` and a `format` (`amount`, `tokenAmount`, `date`, `duration`, `addressName`, `enum`, `calldata` for nested calls, …) and a `visible` rule.
  - `includes` for reuse.
- **Binding is the trust primitive:** "app developers MUST set restrictive constraints; wallets MUST verify all constraints." For an unknown selector, wallets "SHOULD display a safe fallback" and "MUST NOT attempt to apply any unrelated format specifications".
- **Interpolated intents:** wallets MUST show either the `interpolatedIntent` or the intent+fields screens. If interpolation fails, they "MUST fall back" to the plain intent.
- **Versioning:** a wallet "MUST consider a descriptor invalid" if it doesn't implement the `$schema` MAJOR. Newer MINOR/PATCH must still be processed.
- **Registry:** "Curation and registry of ERC-7730 files are out of scope", and any registry "MUST assume it will be targeted". The spec recommends provenance/attestations, tamper-evident history and multi-party governance. External data (token tickers, ENS) is called out as a trust dependency.

**Ledger's deployment of it**

- Protocol authors open a PR to the public registry (`ethereum/clear-signing-erc7730-registry`). Ledger validates it, and wallets fetch the metadata at signing time through Ledger's "context module". Ledger: "Clear Signing never modifies the transaction; it adds a display layer that is verified on the signer itself."
- **How the device trusts metadata** (Ledger Ethereum app APDU doc):
  - Every metadata blob the host pushes (ERC-20 token info, NFT info, plugin selection, map entries) carries a signature that the device checks against an embedded key. Token info in TLV form is "signed via the Ledger PKI (key usage `COIN_META`)", and map entries are "signed by CAL".
  - EIP-712 filters are each signed over chain ID, contract address, a **schema hash** (sha224 of the `types`) and the field path. Each filter type has a distinct magic byte, so a signature for one kind can't be replayed as another.
  - For generic clear signing, the device stores the calldata, receives field descriptors, then "check[s] computed fields hash" before display.
- **Fallback:** "If no descriptor exists for the target contract, the signer falls back to blind signing," and the wallet should show a clear blind-signing warning. On the device, blind signing of contract data is a **setting the user must turn on** ("Blind signing", formerly "Contract data"; per [Ledger Academy](https://ledger.com/academy/enable-blind-signing-why-when-and-how-to-stay-safe) and third-party guides). Ledger Earn treats one un-clear-signed call as a release blocker.
- **Lesson:**
  - The descriptor (how to display) and the payload (what is signed) come from different parties.
  - The descriptor is bound to the payload by on-device checks: address, chain, selector, schema hash.
  - The descriptor's authenticity is a signature by a key the signer already trusts.
  - The **requester never supplies the trusted display**.

## 8. Blind-signing incidents

**Bybit, 21 Feb 2025, about $1.4–1.5B.** Sources: [NCC Group technical analysis](https://www.nccgroup.com/research/in-depth-technical-analysis-of-the-bybit-hack/) and Sygnia/Verichains findings as reported by [BleepingComputer](https://www.bleepingcomputer.com/news/security/lazarus-hacked-bybit-via-breached-safe-wallet-developer-machine/amp/). The primary Sygnia/Verichains PDFs were not reached.

- Attackers compromised a Safe{Wallet} developer machine and changed JavaScript served from Safe's S3 bucket. The change stayed dormant except for Bybit's cold-wallet address.
- At signing time it swapped the Safe transaction to `to = attacker contract`, `operation = 1` (delegatecall). The web UI showed the intended transfer. The hardware wallets were asked to sign the tampered message, and the signers approved it.
- The delegatecall overwrote the proxy's masterCopy slot, which gave the attacker full control.
- NCC: "the underlying data is not human-readable, making it easy to mistake one for the other", and "blind signing is highly likely to occur". Mitigations NCC lists: clear-signing on the hardware wallet, removing delegatecall capability, server-side hash/signature checks, JS pinning/SRI, an independent policy-check service.

**Radiant Capital, 16 Oct 2024, about $50M.** Sources: secondary coverage of Radiant's own post-mortem and its Mandiant-assisted update ([crypto.news](https://crypto.news/post-mortem-reveals-stealthy-malware-injection-led-to-50m-radiant-capital-exploit/), [Halborn](https://www.halborn.com/blog/post/explained-the-radiant-capital-hack-october-2024)). The Radiant Medium post returned 403.

- Malware on the developers' machines showed legitimate transactions in the Safe UI while sending a malicious `transferOwnership()` to the hardware wallets.
- The transactions were simulated on Tenderly and reviewed. The Ledgers did not decode Safe transactions, so the signers signed blind. It was a 3-of-11 multisig.
- Attributed by Mandiant to a DPRK-nexus actor (UNC4736).

**Common lessons:**

1. The machine that **builds and displays** the request is the attack surface. Simulation, multisig and code review all ran *on or through the compromised layer*.
2. The only check that survives that compromise is one done **by the signer, on the bytes it signs**.
3. When structured data has a dangerous mode (delegatecall, ownership transfer, sighash flags), that mode has to be shown prominently. Getting the message structured (EIP-712) is not enough.

## Comparison

| | Transport | Envelope | Versioning | Display metadata | Who it's trusted from |
|---|---|---|---|---|---|
| PSBT / PSBTv2 | any (file/QR/USB) | binary key-value maps | global version field; unknown version ⇒ stop; unknown keys preserved | verifiable data (prev tx, scripts, BIP32 paths), no labels | recomputation by signer |
| PSET | any | PSBTv2 + `pset` proprietary keys | inherits v2 | commitments + proofs; signer unblinds | recomputation + proofs |
| BIP-388 | host↔device | template + key vector | spec version | policy + name | user approval once, then a signer-held MAC/storage |
| EIP-1193 | injected JS object | `{method, params}` | method names | none | n/a |
| EIP-712 | via 1193 / WC | `{types, primaryType, domain, message}` | domain `version` (app's) | field/type names | requester (untrusted); domain checks only |
| WalletConnect v2 | encrypted relay | JSON-RPC in typed encrypted envelopes | protocol version; namespaces for capabilities | proposer metadata | self-asserted; Verify attests origin |
| ERC-7730 / Ledger | fetched separately from registry | JSON descriptor bound to address/chain/selector/schema | `$schema` MAJOR must be supported | intents, field formats, token/enum metadata | binding constraints + curator signature (Ledger PKI) |

## Implications for our Signing Request protocol

These are recommendations to feed the design tickets. None of them is a decision yet.

1. **Wrap, don't reinvent, the chain payload.** A Signing Request should be a thin envelope around a **chain-native unsigned payload**: PSET (PSBTv2) for the Elements sidechain, PSBT for L1. That gets proven signer rules (prevout hash check, sighash check, blinding-complete check, change detection by derivation) for free, plus existing tooling for Sidechain Server devs.

2. **Envelope fields, borrowed piecemeal:**
   - `protocolVersion` (the envelope's own MAJOR.MINOR)
   - `chain`, a CAIP-2-style ID for the sidechain
   - `method` (EIP-1193 / WalletConnect style: `signPset`, `signMessage`, …)
   - `payload`, the native bytes
   - `requestId`
   - `expiry`, bounded as in WalletConnect
   - optional `hints`

   Responses and errors reuse the EIP-1193 code space (4001 rejected, 4100 unauthorized, 4200 unsupported, 4901 chain not connected) so web devs recognize them.

3. **Versioning rules:** the Wallet Base **rejects an unknown envelope MAJOR** (PSBT "exit immediately", ERC-7730 "MUST consider invalid"). It **preserves unknown payload fields** byte-for-byte (PSBT pass-through). Anything it didn't understand pushes the request toward Blind Signing, never toward a silently cleaner view.

4. **Everything the Sidechain Server says about meaning is a hint, never the display.**
   - The Sidechain Server sits where Safe's UI and Radiant's frontends sat. A compromised server must not be able to change what the user sees.
   - A **Decoder** renders Clear Signing views only from the bytes being signed, plus data the wallet can check: prev txs, its own derivation paths and blinding keys, registered policies.
   - Server hints (labels, "this is change", USD values) are shown, if at all, visibly tagged as "reported by Sidechain Server". That fits the map's standing decision to label server-reported state.

5. **Change and own-output detection by derivation.** Following BIP174/BIP-388, the Decoder marks an output "yours/change" only after re-deriving the script (and, for PSET, unblinding with its own key). The server's word is not enough.

6. **Decoders are the ERC-7730 analogue, and need a binding plus a trust anchor.**
   - Each Decoder should declare exactly what it applies to (chain ID, payload type/version, script templates or contract IDs) and refuse everything else ("MUST NOT apply unrelated format specifications").
   - Decoders ship inside the Wallet Base, or, if third parties later contribute them, as signed and bound descriptors. A per-sidechain Decoder written by the sidechain's own maintainers is the case ERC-7730 flags: a registry "MUST assume it will be targeted".

7. **Blind Signing is an explicit, gated state.**
   - When no Decoder matches, or a Decoder can't fully explain the payload, the request is Blind.
   - The UI says so loudly and shows the raw facts it *can* verify: inputs it owns, total leaving the wallet, fee, unrecognized fields, dangerous flags such as non-`ALL` sighash.
   - Blind Signing is opt-in per Sidechain Server (Ledger's "Blind signing" setting is the precedent).
   - Partial decoding must not look like full Clear Signing.

8. **Surface dangerous modes first.** Lesson from Bybit's delegatecall: each Decoder should list its chain's "dangerous mode" bits (sighash flags such as `ANYONECANPAY`/`NONE`/`SINGLE`, PSBTv2 modifiable flags, peg-out/withdrawal outputs, asset issuance/reissuance) and show them above the fold.

9. **Domain-separate everything signed.** Non-transaction signatures (login, message signing) get an EIP-712/ERC-191-style prefix plus a domain (chain, Sidechain Server identity, purpose). That way a message signature can never double as a transaction signature or be replayed on another sidechain. Replay protection beyond that belongs to the protocol using the signature (EIP-712's explicit stance).

10. **Per-server permissions, WalletConnect-namespace style.** A Sidechain Server proposes `{chains, methods}` once, and the user approves once, BIP-388 style ("approve this server/policy, then reference it by name"). The approval is stored by the Wallet Base. Later requests outside the grant fail with 4100.

11. **Origin/identity of the Sidechain Server must be authenticated, not self-asserted.** WalletConnect's proposer metadata is spoofable, and Verify exists to patch that. We need our own answer before Clear Signing can say "Sidechain X asks you to…" (see open questions).

## Open uncertainties

- WalletConnect Verify: the spec pages read only define `POST /attestation {attestationId, origin}` and `GET /attestation/:id → {origin}`. The attestationId derivation and the VALID/INVALID/UNKNOWN/`isScam` statuses come from SDK docs not verified here.
- Ledger: the APDU doc names "Ledger PKI (COIN_META)" and "CAL" for some metadata signatures but doesn't name the owner of every key (plugins, NFT, EIP-712 filters, trusted names). The full device-side verification chain for generic clear signing isn't publicly documented in what was read.
- ERC-7730 is still a Draft. The `required`/`excluded` semantics and the tail of Security Considerations were not fully read.
- Bybit and Radiant are cited through NCC Group and secondary coverage. The primary Sygnia/Verichains reports and the Radiant Medium post (HTTP 403) were not read directly. Details such as which hardware wallets showed what are contested between sources.
- Whether the ECX Elements drivechain uses stock PSET, and how its drivechain deposit/withdrawal fields map onto PSET's federated-peg fields, is unknown.
