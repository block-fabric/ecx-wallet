# Sidechain Server API, pull side: draft 1

This directory holds the stub Elements Sidechain Server (`src/server.mjs`) and the first draft of
the protocol it implements. A sidechain team can build a real Sidechain Server from this document
and check it against the stub. Vocabulary follows [GLOSSARY.md](../GLOSSARY.md). The Signing
Request envelope and how the wallet validates it come from the
[Wallet Base spec](https://github.com/marcusmmmz/ecx-wallet/issues/18).

The stub is for testing only. It answers from a fixture table, never signs, and never broadcasts.

## Roles

- The **Wallet Base** holds the keys. It derives the user's addresses with the Slot's Chain Module,
  registers them with the server, shows what the server reports, and signs Signing Requests after
  the user approves them.
- The **Sidechain Server** knows the chain's rules and state. It reports balances and history for
  the addresses it watches, builds unsigned transactions as Signing Requests, and takes back signed
  payloads to finalize and broadcast.

The wallet treats everything a server says as **reported**:
- balances are shown labelled "Reported by <server URL>";
- a built transfer is an untrusted Signing Request. The wallet decodes it with its own Chain Module
  and the user approves exactly what that module decodes.

**The server never hands out addresses.** The wallet derives every address itself, so a malicious
server can't substitute one it controls. The API has no endpoint that returns an address for the
wallet to use.

## Transport

- HTTPS + JSON (`Content-Type: application/json`), UTF-8. The stub uses plain HTTP on loopback.
- Base URL: the network's `sidechainServer` in the Slot's Chain Entry (for Slot 24:
  `core/elements/chain-entry.json`). Paths below are relative to it. The extension build grants
  itself access to exactly these origins (`host_permissions` and CSP `connect-src`).
- The wallet calls from an extension origin with `credentials: "omit"`. Send CORS headers on every
  answer and answer `OPTIONS` preflights with `204`:
  - `Access-Control-Allow-Origin: *`
  - `Access-Control-Allow-Methods: GET, POST`
  - `Access-Control-Allow-Headers: Content-Type`
  - for servers on a private network, also `Access-Control-Allow-Private-Network: true`.
- Amounts are integer base units, written as decimal **strings** (`"150000"`) so they survive JSON
  number precision. Assets are 64-char lowercase display hex.
- Errors use a 4xx/5xx status with this body:

  ```json
  { "error": { "code": "cannotBuild", "message": "Human-readable, shown to the user." } }
  ```

  The wallet shows `message` to the user. Codes the stub uses: `badRequest`, `notFound`,
  `methodNotAllowed`, `unknownWatch`, `cannotBuild`, `unknownRequest`, `alreadySubmitted`,
  `internal`.
- Versioning: every path starts with `/v1`. A breaking change gets a new prefix.

## Endpoints

### 1. Register watch data: `POST /v1/watch`

The wallet registers what its Chain Module derived from the Slot's Starter. It sends this before
every read and every build, and the call is idempotent.

```json
{
  "chain": "ecash:betanet-s24",
  "descriptor": "elwpkh([3b27f87d/84h/1h/0h]tpubDC…/<0;1>/*)",
  "addresses": [
    { "index": 0, "address": "elements1qew44aehkjstjm56ng2rjrz57vwxh5g9su6dlpm", "scriptPubkey": "0014…" }
  ]
}
```

| Field | Meaning |
|---|---|
| `chain` | CAIP-2 in the `ecash` namespace: `ecash:<network>-s<slot>`. Refuse a chain you don't serve (`400`). |
| `descriptor` | Public watch data from the Chain Module's `deriveAccount`. For Elements it is `elwpkh([fingerprint/84h/1h/0h]tpub…/<0;1>/*)`: receive chain `/0/*`, change chain `/1/*`. It carries no spend authority. |
| `addresses` | The first receive addresses (today 20), in the chain's own encoding, with their index and script. |

The server needs the descriptor, not only addresses, to build transfers the wallet will sign (see
"Building a Signing Request").

**200**: `{ "watchId": "<opaque string>" }`. The same `chain` and `descriptor` must give the same
`watchId`. The stub uses the first 32 hex chars of `sha256(chain + "\n" + descriptor)`.

### 2. Read reported state: `GET /v1/watch/{watchId}/state`

**200**:

```json
{
  "chain": "ecash:betanet-s24",
  "balances": [{ "asset": "5836dcc0…b2c8", "amount": "150000" }],
  "history": [{ "txid": "aa…", "amounts": [{ "asset": "5836dcc0…b2c8", "amount": "150000" }] }]
}
```

- `balances`: one entry per asset the watch holds (confirmed, spendable), each with
  `amount` ≥ `"0"`. The wallet renders one row per entry and refuses an answer whose entries aren't
  `{ asset: hex64, amount: decimal string }`.
- `history`: transactions touching the watch, newest first. Draft 1 fixes only `txid` and
  `amounts`. The wallet doesn't show history yet.

`404 unknownWatch` if the `watchId` was never registered. The wallet registers before each read and build, so a server may forget watches.

### 3. Build a transfer: `POST /v1/watch/{watchId}/transfers`

```json
{ "asset": "5836dcc0…b2c8", "amount": "120000", "destination": "elements1qepkhlwlq2qjggg89d5quqx8z59vz9mr2h6j4pc" }
```

**200**: a Signing Request:

```json
{
  "version": "1.0",
  "id": "4b7c…",
  "chain": "ecash:betanet-s24",
  "method": "signTransaction",
  "format": "pset",
  "payload": "<base64 PSET>",
  "expiresAt": 1792474200,
  "hints": { "summary": "optional", "outputLabels": { "0": "optional" } }
}
```

| Field | Rule |
|---|---|
| `version` | `MAJOR.MINOR`, `"1.0"`. The wallet refuses an unknown MAJOR and ignores unknown fields. |
| `id` | Unique per request. It is the key for submission. |
| `chain` | The chain registered for this watch. The wallet refuses a request for any other Slot or network. |
| `method` | `signTransaction` (`fundTransaction` is reserved). |
| `format` | `pset` for Elements (`psbt` and `borsh-tx` are reserved). |
| `payload` | Base64 of the unsigned transaction in `format`. |
| `expiresAt` | Required, in seconds since the epoch. The wallet refuses an expired request, including one that expires while the user reviews it. Give the user minutes (the stub gives 600 s). |
| `hints` | Optional, untrusted. The wallet only ever shows them tagged "Reported by <server URL>", next to its own decoding. They never replace it. |

`422 cannotBuild` when the transfer can't be built (insufficient funds, bad destination…), with a
message the user can act on. The stub builds nothing: it matches `(asset, amount, destination)`
exactly against its fixture table and answers `422` for anything else.

#### Building a Signing Request the wallet will sign (Elements, draft 1)

The wallet runs, in order:
1. the envelope checks (MAJOR, expiry);
2. the Chain Module's binding: its Slot, `chain` and `format`;
3. the payload rules:
   - the PSET's ELIP-101 genesis field must equal the network's genesis hash from the Chain Entry;
   - **no confidential inputs or outputs**: wallets are explicit-only today;
   - every input the wallet is to sign carries `witness_utxo` and `bip32_derivation`, with a
     derivation path `m/84'/1'/0'/{0,1}/i` under the registered fingerprint.

Change outputs back to the wallet should carry `bip32_derivation` on the internal chain (`/1/i`), so
the wallet can re-derive them and show them as "yours". Without it they show as "not yours".

A request built from a pull-path Send **must be fully Clear-decodable**. There is no Grant behind
it, so there is no Blind Signing opt-in. The wallet refuses, without asking the user, anything its
Decoder can't fully explain, such as unknown PSET fields or unusual structure.
Non-default sighash flags and withdrawal burns are decodable but listed to the user as dangerous, so
don't add them to an ordinary transfer.

### 4. Submit a signed payload: `POST /v1/watch/{watchId}/submissions`

```json
{ "requestId": "4b7c…", "payload": "<base64 PSET>" }
```

`payload` is the request's PSET with the wallet's signatures added (partial signatures on the inputs
it owns). The wallet neither finalizes nor broadcasts it. The server should:
- check that it issued `requestId` to this watch and that the payload is the same unsigned
  transaction;
- finalize, broadcast, and answer.

**200**: `{ "requestId": "4b7c…", "accepted": true, "txid": "<optional>" }`.

- `404 unknownRequest`: no such request for this watch.
- `409 alreadySubmitted`: already submitted.

The stub only records the submission (`submissions()`) and returns no `txid`.

## The stub

- `createStubServer({ chain, state, transfers, now })` from `@ecx/stub-server` (`src/server.mjs`):
  - `state` maps an address to `{ balances, history }`, and a watch's state sums its registered
    addresses;
  - `transfers` is the fixture table:
    `[{ asset, amount, destination, payload, expiresIn?, hints? }]`.
  - It returns `{ listen(port, host), close(), registrations(), submissions() }`. The last two let
    tests observe the server without test-only HTTP routes.
- `pnpm --filter @ecx/stub-server start` runs it on Slot 24's Chain Entry URL
  (`http://127.0.0.1:24024`) for the "abandon … about" test wallet, with the `clear` fixture from
  `e2e/fixtures/elements-psets.json`.
- In the e2e suite: `serveSidechainServer(config)` in `e2e/harness.mjs`, used by
  `e2e/tests/pull-path.test.mjs`.

## Open for later drafts

- How the wallet learns a server's identity (`info`) and how user server overrides work (spec #12).
- Pagination and confirmations in `history`, plus unconfirmed balances.
- Fee selection in the build request.
- Confidential transactions: View Key sharing, blinding, and `fundTransaction`.
- How the server reports that a submission was broadcast or confirmed.
