# A Chain Entry names its Sidechain Server's Server API; Elements uses Esplora

The pull path was built for one protocol, the Standard Sidechain API (`/v1`): every chain's maintainers run a server that reports state, builds transfers as Signing Requests and broadcasts them. The Elements drivechain already has a public indexer run by its developer, `https://explorer.bitnames.info/api`, which is Blockstream's Esplora (electrs `new-index`) and serves the betanet whose genesis is in Slot 24's Chain Entry. Nobody runs a `/v1` server for it. So the Chain Entry names, per network, both the URL and the Server API the Wallet Base speaks to it:

```json
"sidechainServer": { "api": "esplora", "url": "https://explorer.bitnames.info/api" }
```

`api` is `"ecx-v0"` (the Standard Sidechain API), `"esplora"`, or `"flush"` (Esplora with Flush's finality, ADR 0012), with no default. A user server override (spec #12) is the same `{api, url}` pair.

`"esplora"` means the Esplora REST API as Blockstream electrs serves it, limited to endpoints mempool's electrs fork also serves, so either fork works:

| Endpoint | Use |
|---|---|
| `GET /block-height/H` | Identity check: must equal the Chain Entry's `identityBlock` (`H` = 0 and the genesis, or a fork's first block: ADR 0003), else a hard error. Run on first contact and after every URL change; this stands in for `/v1`'s `info`. |
| `GET /address/:a/utxo` | Reported state: outputs summed per asset, confirmed and unconfirmed apart. |
| `GET /address/:a/txs` | History: each watched address's mempool transactions and latest 25 confirmed ones, merged by txid. Older pages with `/txs/chain/:last_seen`, or mempool's `?after_txid=` where that 404s (ADR 0012). |
| `GET /fee-estimates` | Fee rate for building transfers (may be `{}`). |
| `POST /tx` | Broadcasting a finalized transaction. |

No `/api/v1/*` endpoints (mempool.space's Node backend) and no fork-specific extras. Accept any 2xx: mempool's instances answer some calls with 203.

Over Esplora the Wallet Base does what a `/v1` server would: its TypeScript adapter does the I/O, and the Slot's Chain Module builds and finalizes transfers as a pure, optional capability (no I/O, as for every Chain Module). The result is still parsed, decoded and Clear Signed like any other Signing Request.

## Considered Options

- **A wrapper service that speaks `/v1` and calls Esplora:** rejected. The coin selection and PSET building have to be written either way; a wrapper adds a server someone must host and gains nothing in trust, since the wallet decodes whatever it signs.
- **Drop the Standard Sidechain API and require every chain to ship an indexer the Wallet Base speaks:** rejected. Thunder, BitNames, zSide and Truthcoin have no Esplora-like indexer; without `/v1` each would need a backend adapter merged into the Wallet Base, the bottleneck spec #8 set out to avoid.
- **Keep `/v1` but drop its build and submit half, so every Chain Module builds:** rejected for now. Some chains can't build without server-side state (zSide proofs, BitNames lookups).
- **Electrum protocol over WebSocket:** not now. It would give push subscriptions, but the only Electrum server for Elements (Blockstream electrs with `liquid`) is TCP-only, so it needs a WebSocket proxy nobody runs. Add `"electrum-ws"` as a Server API when a deployment exists.
- **mempool.space's WebSocket API (`/api/v1/ws`):** not now. It belongs to mempool's Node backend, which the Elements explorer doesn't run. Add `"mempool"` as a Server API when a deployment exists.

## Consequences

- No bundled chain speaks the Standard Sidechain API in v0. Its client, stub and protocol draft (`stub-server/README.md`) stay for the chains that will; their tests run in Node, not the browser.
- The Elements Chain Module gains building and finalizing, beyond derive, decode and sign.
- Esplora has no push: live updates over it mean polling (the chain tip, then outputs when it changes).
- A Sidechain Server is no longer always the one that builds transactions; the glossary entry says so.
