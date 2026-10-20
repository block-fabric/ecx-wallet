# ECX Wallet

A multi-drivechain browser wallet for eCash (ECX). Design: [wayfinder map](https://github.com/marcusmmmz/ecx-wallet/issues/1);
current build target: [Wallet Base walking skeleton](https://github.com/marcusmmmz/ecx-wallet/issues/18).
Vocabulary: [GLOSSARY.md](GLOSSARY.md).

## Layout

pnpm workspace, one directory per module from the spec:

| Dir | What it is |
|---|---|
| `core/` | Rust signing core: a Cargo workspace, one import-free `.wasm` per module (today `vault.wasm`). See `core/README.md`. |
| `wallet/` | Target-agnostic TypeScript: Grants, the Provider request handler (`createProviderHandler`), Vault orchestration (`createVault`: encryption at rest, unlock state, auto-lock) and the hand-written WASM glue (`CoreModule`, `loadVaultModule`). Later: Signing Request validation, Chain Module loading. |
| `app/` | SvelteKit UI (adapter-static, hash router, so SSR is off). Built as one `index.html` shell; screens are hash routes, e.g. `index.html#/approve/<id>`. |
| `extension/` | MV3 shell: hand-written `manifests/chromium.json` and `manifests/firefox.json`; `src/background.ts`, `src/content.ts`, `src/inpage.ts` bundled with esbuild (not SvelteKit). |
| `client/` | Library Sidechain Apps use to discover the Provider (`discoverProviders()`). |
| `e2e/` | Seam 1 harness and tests: the built extension in headless Brave and Firefox. |

Request path: page → `client` discovery → injected Provider (`inpage.ts`, main world) → content script
(relay) → background (derives the origin from the browser's `sender`) → `wallet`'s Provider handler.
The approval window is the `app` page at `#/approve/<id>`; it talks to the background only by
`runtime.sendMessage`.

Vault: the app's onboarding (`#/create`, `#/import`) and unlock pages send `vault.*` messages; only
the background decrypts. The Master Mnemonic is stored only encrypted (password → Argon2id in
`vault.wasm` → AES-GCM via WebCrypto) in `storage.local`; while unlocked, the vault key sits in
`storage.session` with a deadline (15 min auto-lock, also enforced on every use), so it survives
service-worker restarts and is gone after a browser restart. In the background,
`await vault.starter(slot)` gives a Slot's Starter (throws if locked; counts as activity).

## Build and test

Needs node 22, pnpm, rustup (the toolchain is pinned in `core/rust-toolchain.toml`), clang with the
WebAssembly backend and `llvm-ar` (see `core/README.md`), and Brave at `/usr/bin/brave` (or `$BRAVE`).
Firefox at `/usr/bin/firefox` (or `$FIREFOX`) for its half of the suite. No Chrome is downloaded
(puppeteer-core).

```sh
pnpm install
pnpm test          # Rust tests (Seam 2), then builds core + app + extension and runs the e2e suite
pnpm build         # just builds: core/dist/*.wasm, then extension/dist/chromium and extension/dist/firefox
pnpm typecheck
```

- Only one browser: `E2E_BROWSERS=brave pnpm test` (default `brave,firefox`). Watch it: `HEADFUL=1`.
- Load the build by hand: `brave://extensions` → Developer mode → Load unpacked → `extension/dist/chromium`.

### MV3 fixes applied to the SvelteKit output

- `app/scripts/mv3-postbuild.mjs` moves SvelteKit's inline bootstrap `<script>` into a file
  (MV3 extension pages can't run inline scripts, and the CSP stays `script-src 'self' 'wasm-unsafe-eval'`).
- `kit.appDir` is `kit`, not `_app` (Chrome rejects extension paths starting with `_`).

### Build gates

- `core/scripts/build.mjs` fails unless every `.wasm` imports nothing but memory.
- `extension/scripts/build.mjs` stages each `.wasm` once, so both browser builds ship identical
  bytes, and fails if any shipped script contains `eval(` or `new Function(`.

### Writing e2e tests

`e2e/harness.mjs` exports `launchWallet(name)` / `launchBrave()` / `launchFirefox()`, `serveTestApp()`
and `openTestApp(session, app, host)`. Each `<name>.localhost` host is its own origin (Grants are per
origin). The test Sidechain App (`e2e/test-app/`) exposes `window.testApp.request(method, params)`
returning `{ result }` or `{ error: { code, message } }`. A session has `waitForApprovalWindow()`,
`approvalWindows()`, `openPage(path)` (a wallet page, e.g. `index.html#/import`; wait for an element
on it before use, since Firefox never reports moz-extension loads as finished), and on Brave
`extensionErrors()` and `stopServiceWorker()`. `launchBrave({ profile })` reuses a profile dir to
restart the browser on it. Firefox's extension UUID is pinned, so wallet pages have a fixed URL.

Puppeteer must never attach to the extension's service worker (`targetFilter` in the harness); to
restart the worker, use `session.stopServiceWorker()` (CDP `ServiceWorker.stopWorker` over an
extension page's session).
