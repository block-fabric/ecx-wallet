# ECX Wallet

A browser wallet for eCash (ECX) and its drivechains, built as one shared base that each sidechain's maintainers extend from their own side.

## Language

### Wallet

**Wallet Base**:
The shared browser wallet every user runs: it holds keys, signs, presents the UI, and handles the eCash mainchain.
_Avoid_: Core wallet, host wallet

### Keys

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

**Sidechain Server**:
A server run by a sidechain's maintainers that knows that chain's rules and state and produces unsigned payloads for the Wallet Base to sign.
_Avoid_: Adapter, backend, sidechain plugin

**Sidechain App**:
A sidechain's own web UI that asks the Wallet Base to sign for that chain's specific features.
_Avoid_: dApp, frontend, sidechain website

**Provider**:
The object the Wallet Base exposes to Sidechain Apps, through which they connect, ask for Grants, and send Signing Requests.
_Avoid_: Wallet API, bridge, connector

**Grant**:
A user's stored approval letting one Sidechain App, identified by its web origin, request certain methods on certain Slots.
_Avoid_: Permission, connection, session

### Signing

**Signing Request**:
A payload a Sidechain Server hands the Wallet Base to be signed with the user's keys.
_Avoid_: Sign request, transaction request, blob

**Blind Signing**:
Approving a Signing Request without the Wallet Base being able to show the user what it means.

**Clear Signing**:
Approving a Signing Request after the Wallet Base has shown the user a decoded, human-readable account of what it does.

**Decoder**:
A Wallet Base module that turns one sidechain's Signing Requests into a Clear Signing view.
_Avoid_: Parser, interpreter, renderer
