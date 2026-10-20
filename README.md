# ECX Wallet

A multi-drivechain browser wallet for eCash (ECX). Design: [wayfinder map](https://github.com/marcusmmmz/ecx-wallet/issues/1);
current build target: [Wallet Base walking skeleton](https://github.com/marcusmmmz/ecx-wallet/issues/18).
Vocabulary: [GLOSSARY.md](GLOSSARY.md).

## Layout

pnpm workspace, one directory per module from the spec:

| Dir | What it is |
|---|---|
| `core/` | Rust signing core (Vault, Chain Modules), one `.wasm` per module. Placeholder until #20. |
| `wallet/` | Target-agnostic TypeScript: Grants and the Provider request handler (`createProviderHandler`). Later: Vault orchestration, Signing Request validation, Chain Module WASM loading. |
| `app/` | SvelteKit UI (adapter-static, hash router, so SSR is off). Built as one `index.html` shell; screens are hash routes, e.g. `index.html#/approve/<id>`. |
| `extension/` | MV3 shell: hand-written `manifests/chromium.json` and `manifests/firefox.json`; `src/background.ts`, `src/content.ts`, `src/inpage.ts` bundled with esbuild (not SvelteKit). |
| `client/` | Library Sidechain Apps use to discover the Provider (`discoverProviders()`). |
| `e2e/` | Seam 1 harness and tests: the built extension in headless Brave and Firefox. |

Request path: page → `client` discovery → injected Provider (`inpage.ts`, main world) → content script
(relay) → background (derives the origin from the browser's `sender`) → `wallet`'s Provider handler.
The approval window is the `app` page at `#/approve/<id>`; it talks to the background only by
`runtime.sendMessage`.

## Build and test

Needs node 22, pnpm, and Brave at `/usr/bin/brave` (or `$BRAVE`). Firefox at `/usr/bin/firefox`
(or `$FIREFOX`) for its half of the suite. No Chrome is downloaded (puppeteer-core).

```sh
pnpm install
pnpm test          # builds app + extension, then runs the whole e2e suite
pnpm build         # just builds: extension/dist/chromium and extension/dist/firefox
pnpm typecheck
```

- Only one browser: `E2E_BROWSERS=brave pnpm test` (default `brave,firefox`). Watch it: `HEADFUL=1`.
- Load the build by hand: `brave://extensions` → Developer mode → Load unpacked → `extension/dist/chromium`.

### MV3 fixes applied to the SvelteKit output

- `app/scripts/mv3-postbuild.mjs` moves SvelteKit's inline bootstrap `<script>` into a file
  (MV3 extension pages can't run inline scripts, and the CSP stays `script-src 'self' 'wasm-unsafe-eval'`).
- `kit.appDir` is `kit`, not `_app` (Chrome rejects extension paths starting with `_`).

### Writing e2e tests

`e2e/harness.mjs` exports `launchWallet(name)` / `launchBrave()` / `launchFirefox()`, `serveTestApp()`
and `openTestApp(session, app, host)`. Each `<name>.localhost` host is its own origin (Grants are per
origin). The test Sidechain App (`e2e/test-app/`) exposes `window.testApp.request(method, params)`
returning `{ result }` or `{ error: { code, message } }`. A session has `waitForApprovalWindow()`,
`approvalWindows()`, and on Brave `extensionErrors()`.

Puppeteer must never attach to the extension's service worker (`targetFilter` in the harness); to
restart the worker, use `ServiceWorker.stopWorker` over a page's CDP session.
