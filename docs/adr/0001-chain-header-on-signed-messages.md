# Signed messages carry a wallet-added chain header

ECX L1 and the Elements drivechain both keep Bitcoin's `"Bitcoin Signed Message:\n"` magic and Bitcoin's address formats. ECX L1 keys are also Bitcoin-identical. So if a message is signed the standard way for an ECX address, the same signature is valid for the matching BTC address, and the same is true between ECX networks. A malicious Sidechain App could get a user to sign text that some Bitcoin service treats as authorization. To prevent that, the Wallet Base always prepends a fixed header it controls before `signMessage` signs anything:

```
eCash signed message
Chain: <CAIP-2 chain ID>

<message>
```

The result then goes into the chain's normal container: BIP-322 simple on L1, legacy-magic ECDSA on Elements, and the chain's own message separation byte elsewhere. The App gets back the exact bytes that were signed. `signIn` uses CAIP-122 instead, which binds the chain through its `Chain ID:` line.

## Considered Options

- **Sign the App's text unmodified (drop-in compatible):** rejected. It leaves BTC↔ECX and cross-network replay open.
- **A new magic string such as `"eCash Signed Message:\n"`:** rejected. It breaks every existing verifier. The header binds the chain just as well, and standard tools can still verify the signature.

## Consequences

The header text is part of the Wallet Base spec, and changing it means a new spec version. A verifier has to check the header along with the message. A Chain Module whose chain has no message domain separation of its own (Thunder, CoinShift) can't offer `signMessage` until that chain defines one.
