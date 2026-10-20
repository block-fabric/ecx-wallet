# ECX Wallet

A multi-drivechain browser wallet for eCash (ECX). Design: [wayfinder map](https://github.com/marcusmmmz/ecx-wallet/issues/1);
current build target: [Wallet Base walking skeleton](https://github.com/marcusmmmz/ecx-wallet/issues/18).
Vocabulary: [GLOSSARY.md](GLOSSARY.md).

## Layout

pnpm workspace, one directory per module from the spec:

| Dir | What it is |
|---|---|
| `core/` | Rust signing core: a Cargo workspace, one import-free `.wasm` per module (`vault.wasm`, `elements.wasm`). See `core/README.md`. |
| `wallet/` | Target-agnostic TypeScript: Grants, the Provider request handler (`createProviderHandler`), Vault orchestration (`createVault`: encryption at rest, unlock state, auto-lock), per-Slot accounts (`createChainModules`, `createAccounts`) the hand-written WASM glue (`CoreModule`, `loadVaultModule`, `loadChainModule`) and Signing Request validation (`parseSigningRequest`, then the Grant and the Chain Module in the Provider handler). |
| `app/` | SvelteKit UI (adapter-static, hash router, so SSR is off). Built as one `index.html` shell; screens are hash routes, e.g. `index.html#/approve/<id>`, `index.html#/grants`. |
| `extension/` | MV3 shell: hand-written `manifests/chromium.json` and `manifests/firefox.json`; `src/background.ts`, `src/content.ts`, `src/inpage.ts` bundled with esbuild (not SvelteKit). |
| `client/` | Library Sidechain Apps use to discover the Provider (`discoverProviders()`). |
| `stub-server/` | Stub Sidechain Servers answered from fixtures: the Standard Sidechain API (`createStubServer`, with that API's protocol draft in `stub-server/README.md`) and Esplora (`createEsploraStub`, the e2e build's Slot 24 server). |
| `e2e/` | Seam 1 harness and tests: the built extension in headless Brave and Firefox, plus node tests of what needs no browser. `e2e/scripts/build.mjs` makes the e2e build (`e2e/dist/`). |

Request path: page → `client` discovery → injected Provider (`inpage.ts`, main world) → content script
(relay) → background (derives the origin from the browser's `sender`) → `wallet`'s Provider handler.
The approval window is the `app` page at `#/approve/<id>`; it talks to the background only by
`runtime.sendMessage`.

Vault: the app's onboarding (`#/create`, `#/import`) and unlock pages send `vault.*` messages; only
the background decrypts. The Master Mnemonic is stored only encrypted (password → Argon2id in
`vault.wasm` → AES-GCM via WebCrypto) in `storage.local`; while unlocked, the vault key sits in
`storage.session` with a deadline (15 min auto-lock, also enforced on every use; `vault.setAutoLock`
only shortens it, clamped to 1-15 min), so it survives
service-worker restarts and is gone after a browser restart. In the background,
`await vault.starter(slot)` gives a Slot's Starter (throws if locked; counts as activity).

Accounts: `accounts.receiveAddresses(slot)` hands that Slot's Starter (and nothing else) to that
Slot's Chain Module, each in its own lazily instantiated WASM instance. The home page shows them
when unlocked (`accounts.list` message); the Provider's `getAddresses({ slot })` returns
`[{ chain, address }]` to an origin whose Grant covers the method and the Slot (4100 otherwise, or
while locked).

Pull path (`wallet/src/pull-path.ts`, `sidechain-server.ts`): each Slot talks to the Sidechain
Server its Chain Entry names for the Chain Module's network, in the Server API it names next to the
URL (`sidechainServer: { api, url }`; docs/adr/0002). Slot 24's betanet is
`{ "api": "esplora", "url": "https://explorer.bitnames.info/api" }` in
`core/elements/chain-entry.json`; the extension build turns those URLs into `host_permissions` and
CSP `connect-src`. `server-api.ts` picks the client:
- `esplora` (`esplora.ts`): checks `/block-height/0` against the Chain Entry's genesis (a mismatch
  is a hard error), then sums the confirmed explicit outputs (`/address/:a/utxo`) of the first 20
  receive and 20 change addresses per asset. Send isn't available over Esplora yet (#28).
- `ecx-v0`, the Standard Sidechain API (`standard-sidechain-api.ts`, `stub-server/README.md`):
  registers the descriptor and first 20 receive addresses before every call. Its Send has the
  server build the transfer; the Signing Request goes through the same validation, Chain Module
  and approval window as a Provider request (`wallet/src/signing.ts`), with the server URL as the
  requester. It must be Clear: there is no Grant, so a Blind request is refused without a window.
  After approval the wallet submits the signed PSET to the server. No bundled chain speaks it in
  v0; `e2e/tests/sidechain-servers.test.mjs` tests it in node.

The home page (`accounts.reported`) shows the balance per asset, labelled "Reported by <server
URL>"; the Send screen is `#/send/<slot>` (`send.start`).

Signing (`signTransaction`): the Provider handler checks, in the spec's order, the envelope (unknown
MAJOR → 4200, unknown fields ignored, expired → -32602), the Grant (Slot + method → 4100), then
hands the payload to that Slot's Chain Module, whose `check` refuses a wrong ELIP-101 genesis, any
confidential input/output, or inputs without `witness_utxo`/`bip32_derivation` (all -32602) without
the Starter, so before any unlock prompt; its `decode` then returns a Clear View or Blind with its
verifiable facts. Blind needs the Grant's Blind Signing opt-in
(a checkbox in the connect prompt, off by default; 4100 without it). One approval window per
request: it asks to unlock first if the wallet is locked, then shows the request; reject → 4001.
`sign` returns the same PSET with signatures on the inputs that re-derive to the Starter.
Fixture PSETs for the e2e suite: `e2e/fixtures/elements-psets.json`, generated by
`core/elements/tests/fixtures.rs` (`UPDATE_FIXTURES=1 cargo test -p ecx-elements --test fixtures`).

## Build and test

Needs node 22, pnpm, rustup (the toolchain is pinned in `core/rust-toolchain.toml`), clang with the
WebAssembly backend and `llvm-ar` (see `core/README.md`), and Brave at `/usr/bin/brave` (or `$BRAVE`).
Firefox at `/usr/bin/firefox` (or `$FIREFOX`) for its half of the suite. No Chrome is downloaded
(puppeteer-core).

```sh
pnpm install
pnpm test          # Rust tests (Seam 2), then builds core + app + extension, the e2e build, and runs the e2e suite
pnpm build         # just builds: core/dist/*.wasm, then extension/dist/chromium and extension/dist/firefox
pnpm build:e2e     # after pnpm build: the e2e build in e2e/dist/extension/{chromium,firefox}
pnpm typecheck
```

- Only one browser: `E2E_BROWSERS=brave pnpm test` (default `brave,firefox`). Watch it: `HEADFUL=1`.
- Load the build by hand: `brave://extensions` → Developer mode → Load unpacked → `extension/dist/chromium`.
- Screenshot every screen (Brave, light or dark): `node e2e/screenshots.mjs <out dir> [light|dark]` after `pnpm build && pnpm build:e2e`.
- Try the e2e build by hand: load `e2e/dist/extension/chromium` and run `pnpm --filter @ecx/stub-server start` (the Esplora stub, answering for "abandon … about").

### The e2e build

The shipped build's Slot 24 server is the public Elements explorer, which tests can't control. So
`e2e/scripts/build.mjs` builds the extension again from the same sources, with one change: betanet's
`sidechainServer` is `E2E_SIDECHAIN_SERVER` (the Esplora stub at `http://127.0.0.1:24024`). The
Chain Entry is compiled into `elements.wasm` (`core/elements/build.rs` takes
`$ECX_ELEMENTS_CHAIN_ENTRY`), so that module is rebuilt, in its own cargo target dir
(`core/target/e2e`). `build-output.test` checks the two builds differ only there: every other file
byte-identical, the manifest only in the server's origin, and the module's `declare()` and
`chainEntry()` only in betanet's server. Browser tests run on the e2e build (`launchWallet`'s
default), so none reaches the public explorer; `extension-loads.test` loads the shipped build
(`{ build: "shipped" }`) and opens only onboarding pages.

### MV3 fixes applied to the SvelteKit output

- `app/scripts/mv3-postbuild.mjs` moves SvelteKit's inline bootstrap `<script>` into a file
  (MV3 extension pages can't run inline scripts, and the CSP stays `script-src 'self' 'wasm-unsafe-eval'`).
- `kit.appDir` is `kit`, not `_app` (Chrome rejects extension paths starting with `_`).

### Build gates

- `core/scripts/build.mjs` fails unless every `.wasm` imports nothing but memory.
- `extension/scripts/build.mjs` stages each `.wasm` once, so both browser builds ship identical
  bytes, and fails if any shipped script contains `eval(` or `new Function(`.

### Writing e2e tests

`e2e/harness.mjs` exports `launchWallet(name, { build })` (`"e2e"` by default, or `"shipped"`) / `launchBrave()` / `launchFirefox()`, `setUpWallet(session)`
(imports `ABANDON`, no passphrase, and leaves the wallet unlocked), `serveTestApp()`
and `openTestApp(session, app, host)`, `serveEsplora(config)` (the stub Esplora server where the e2e build's Chain Entry
names Slot 24's server, `http://127.0.0.1:24024`, so one test file using it at a time), `serveSidechainServer(config)` (the
Standard Sidechain API stub on a free port), `importWallet()` (`wallet/` bundled for node), and `openWalletPage(session, "#/grants")` for a wallet screen (it waits
for `[data-screen-ready]`; Firefox's extension UUID is pinned so its pages have a known URL). Each `<name>.localhost` host is its own origin (Grants are per
origin). The test Sidechain App (`e2e/test-app/`) exposes `window.testApp.request(method, params)`
returning `{ result }` or `{ error: { code, message } }`. A session has `waitForApprovalWindow()`,
`approvalWindows()`, `openPage(path)` (a wallet page, e.g. `index.html#/import`; wait for an element
on it before use, since Firefox never reports moz-extension loads as finished), `extensionErrors()`
(`{ manifestErrors, installWarnings, runtimeErrors }`) and `stopBackground()`.
`launchWallet(name, { profile })` reuses a profile dir to restart the browser on it.

Puppeteer must never attach to the extension's service worker (`targetFilter` in the harness); to
restart the worker, use `session.stopBackground()` (on Brave, CDP `ServiceWorker.stopWorker` over an
extension page's session).

### Firefox

Every e2e test runs on both browsers. On Firefox the background is a non-persistent event page,
and the harness differs from Brave's in three places:

- `extensionErrors()`: Firefox has no extension error console API, so the harness evaluates in the
  browser's chrome context over BiDi (`-remote-allow-system-access`). It reads the add-on's manifest
  errors and warnings (`Extension.errors` / `.warnings`) and every error the browser console records
  from a `moz-extension://` source: uncaught exceptions and CSP violations. `extension-loads`
  installs a deliberately broken build to show these checks aren't vacuous.
- `stopBackground()` calls `Extension.terminateBackground()`, the call Firefox's idle timeout
  makes to suspend the event page.
- Browser restart: Firefox drops a temporary add-on, and its storage, when it closes. A permanent
  install needs a signed add-on, which release Firefox won't skip. So the harness sets
  `extensions.webextensions.keepStorageOnUninstall` and `keepUuidOnUninstall`, and reinstalls the
  add-on on relaunch. What the restart test checks still holds: `storage.local` (the encrypted
  vault) persists, `storage.session` (unlock state) doesn't, and the wallet comes back locked.
  The part the harness simulates is the add-on surviving the restart. That isn't automated; check it
  by hand on a signed or Developer Edition install.
