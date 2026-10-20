# ECX Wallet

A browser wallet for eCash (ECX) and its drivechains, built as one shared base that each sidechain's maintainers extend from their own side.

## Language

### Wallet

**Wallet Base**:
The shared browser wallet every user runs: it holds keys, signs, presents the UI, and handles the eCash mainchain.
_Avoid_: Core wallet, host wallet

### Sidechains

**Sidechain Server**:
A server run by a sidechain's maintainers that knows that chain's rules and state and produces unsigned payloads for the Wallet Base to sign.
_Avoid_: Adapter, backend, sidechain plugin

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
