# ECX Wallet

A browser wallet for eCash (ECX) and its drivechains, built as one shared base that each sidechain's maintainers extend from their own side.

## Language

### Wallet

**Wallet Base**:
The shared browser wallet every user runs: it holds keys, signs, presents the UI, and handles the eCash mainchain.
_Avoid_: Core wallet, host wallet

### Keys

**Vault**:
The part of the Wallet Base that keeps the Master Mnemonic encrypted, unlocks it, and derives Starters from it; the only part that ever sees the Master Mnemonic.
_Avoid_: Keystore, keyring, secret store

**Master Mnemonic**:
The single BIP39 phrase a user backs up; the root of their L1 keys and of every Starter.
_Avoid_: Seed phrase, recovery phrase, master seed

**Starter**:
The per-Slot mnemonic derived from the Master Mnemonic, from which one sidechain's keys are derived by that chain's own rules.
_Avoid_: Sidechain seed, child mnemonic, sub-wallet

**View Key**:
The private blinding key that reveals the hidden amounts of a user's confidential outputs on a sidechain.
_Avoid_: Blinding key (ambiguous: also names the public half), viewing key

### Sidechains

**Slot**:
The BIP300 number (1–255) that identifies a sidechain on eCash.
_Avoid_: Sidechain number, sidechain id

**Treasury**:
The single eCash output holding all coins deposited to a Slot and not yet withdrawn.
_Avoid_: CTIP (BIP300's name for it), escrow

**Deposit**:
Moving coins from eCash into a sidechain by paying them into its Treasury.
_Avoid_: Peg-in

**Withdrawal**:
Moving coins from a sidechain back to eCash, paid out of its Treasury once miners approve it over several months.
_Avoid_: Peg-out

**Chain Entry**:
The description of one sidechain that ships with a Wallet Base release: its Slot, its networks, and its default Sidechain Server and Official Apps on each.
_Avoid_: Chain manifest, chain descriptor, network profile

**Sidechain Server**:
A server run by a sidechain's maintainers that knows that chain's rules and state and produces unsigned payloads for the Wallet Base to sign.
_Avoid_: Adapter, backend, sidechain plugin

**Sidechain App**:
A sidechain's own web UI that asks the Wallet Base to sign for that chain's specific features.
_Avoid_: dApp, frontend, sidechain website

**Official App**:
A Sidechain App whose web origin its sidechain's Chain Entry lists as belonging to that chain's maintainers.
_Avoid_: Verified app, trusted app

**Provider**:
The object the Wallet Base exposes to Sidechain Apps, through which they connect, ask for Grants, and send Signing Requests.
_Avoid_: Wallet API, bridge, connector

**Grant**:
A user's stored approval letting one Sidechain App, identified by its web origin, request certain methods on certain Slots.
_Avoid_: Permission, connection, session

### Signing

**Signing Request**:
A request, from a Sidechain Server or Sidechain App, for the Wallet Base to sign a transaction or message with the user's keys.
_Avoid_: Sign request, transaction request, blob

**Sign-In**:
A Signing Request in which a Sidechain App asks the user to prove control of an address to that App's own origin.
_Avoid_: Login, auth signature

**Blind Signing**:
Approving a Signing Request without the Wallet Base being able to show the user what it means.

**Clear Signing**:
Approving a Signing Request after the Wallet Base has shown the user a decoded, human-readable account of what it does.

**Chain Module**:
The per-chain unit bundled in the Wallet Base that derives a chain's keys from its Starter, decodes its Signing Requests, and signs them.
_Avoid_: Signer module, plugin, adapter

**Clear View**:
The structured, chain-neutral account of a Signing Request that a Decoder produces and the Wallet Base renders for Clear Signing.
_Avoid_: Preview, summary, decoded transaction

**Decoder**:
The part of a Chain Module that turns its chain's Signing Requests into a Clear View.
_Avoid_: Parser, interpreter, renderer
