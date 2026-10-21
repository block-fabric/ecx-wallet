# The Chain Entry names its chain's assets, and which one is ECX

Servers report balances by asset id only, and the home page needs more: a name and ticker for each asset worth naming, how many decimals it has, and which asset on each chain is ECX, the one the wallet adds up into its total across chains. That knowledge comes from the chain's maintainers. So it ships in the Chain Entry, per network, next to the other facts the wallet trusts its release for:

```json
"assets": [
  { "id": "5836dcc0…cb2c8", "ticker": "ECX", "name": "eCash on Elements+", "decimals": 8, "ecx": true }
]
```

`id` is the lowercase hex servers report. Only the root has an asset with an empty id: its native coin, which has no id. A network names each asset at most once and marks at most one as `ecx`. A Chain Module may add its own rule: Elements' ECX must be its `policyAsset`, the asset a Deposit is credited in. Any asset the entry doesn't name shows as "Unknown asset" with its shortened id. The same entry gives the chain's display `name` ("Main chain", "Elements+") and a one-line `description`. The network label shown to users ("Betanet") is the network's key, not a new field.

## Considered Options

- **Read ECX out of each module's `params` (Elements' `policyAsset`):** rejected. Only Elements has a policy asset, so the wallet would need per-module code to find each chain's ECX. An explicit field in the shared envelope works for any chain.
- **An asset registry fetched at run time (like Liquid's asset registry):** rejected for now. Names would then come from a server the wallet doesn't verify, and a fake "ECX" could be counted in the total. Names that ship in the release can't be spoofed by a server.
- **A separate `displayName` beside `name`:** rejected. Nothing uses `name` as an identifier (the CAIP-2 `chain` is the id), so `name` itself became the display name.

## Consequences

- Naming a new asset, or renaming a chain, needs a wallet release, as for any other Chain Entry change.
- Error messages that quote a chain's name now say "Main chain" and "Elements+".
