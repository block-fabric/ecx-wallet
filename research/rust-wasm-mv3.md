# Rust/WASM signing core in a web app and an MV3 extension

Research for [#6](https://github.com/marcusmmmz/ecx-wallet/issues/6). Researched 2026-10-19. Every claim cites the source it comes from, with that source's "last updated" date where it has one. Claims marked **(inference)** are my reasoning, not something a source states.

## Question

What are the constraints and costs of a Rust→WASM crypto/signing core that ships in both a web app and a Manifest V3 browser extension? This covers:

- the MV3 CSP (`wasm-unsafe-eval`)
- WASM in service workers
- the ban on remotely hosted code, and what it means for loading **Decoders** or chain modules at runtime
- bundle size
- Svelte/Vite integration
- reusing the same crate under Tauri later

## Answer in brief

- **WASM is allowed in MV3 on both Chrome and Firefox.** The extension must opt in by adding `'wasm-unsafe-eval'` to `content_security_policy.extension_pages`. MetaMask and the Namada keychain ship exactly this today.
- **No code may be loaded at runtime.** In an extension, WASM or JS fetched from a **Sidechain Server** is remotely hosted code. Both stores ban it. Chrome also bans "an interpreter to run complex commands fetched from a remote source, even if those commands are fetched as data". So in the extension, **Decoders must ship inside the package**, or run in a sandboxed iframe, which is a narrow and policy-fragile exemption. This conflicts with the map's goal that "sidechain devs never wait on wallet devs", and it is the most important finding here.
- **Service workers work, with one trap: no top-level `await`.** The ServiceWorker spec rejects any service worker module graph that contains top-level `await`. Vite's native `.wasm` imports and `vite-plugin-wasm` both depend on top-level `await`. So the background worker must use wasm-bindgen's `--target web` output, register its listeners synchronously, and run `await init(...)` lazily inside the handlers. Namada does exactly this.
- **Firefox has no background service worker.** It runs MV3 background code as an event page (`background.scripts`). Ship both keys in one manifest; this is MDN's own recommendation.
- **Bundle size depends on the crate and is not yet measured for our crate.** Data points: tiny-secp256k1, a Rust→WASM secp256k1 library, ships a 1.24 MB `.wasm`. Namada's full SDK is 6.3 MB. The file is loaded from the local package, but it is recompiled every time the service worker wakes up.
- **Tauri reuse is easy if the crate is layered.** Write a pure-Rust `core` crate with no wasm-bindgen dependency, then a thin `core-wasm` bindings crate. Later, a Tauri app calls `core` natively through `#[tauri::command]`, with no WASM needed.

## 1. MV3 Content Security Policy

**Chrome**
- The default `extension_pages` CSP is `script-src 'self'; object-src 'self';`. Under this default, WebAssembly is disabled.
- The minimum (most permissive) allowed policy is `script-src 'self' 'wasm-unsafe-eval'; object-src 'self';`, and it "cannot be relaxed beyond this minimum value". `'unsafe-eval'` is not allowed.
- Source: [Chrome: Manifest – Content Security Policy](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy) (updated 2024-02-13).
- The policy "applies to page and worker contexts in the extension … the extension popup, background worker, and tabs with HTML pages or iframes". So the background service worker also needs `'wasm-unsafe-eval'` (same source).

**Firefox**
- In MV3, the `script-src` and `worker-src` of `extension_pages` "may only have these values: `'self'`, `'none'`, `'wasm-unsafe-eval'`". Remote URLs, `'unsafe-eval'` and hashes are forbidden.
- MV2 extensions happened to get WASM without the keyword, but "this behavior isn't guaranteed". Source: [MDN: content_security_policy](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/content_security_policy) (modified 2026-08-06).
- "'wasm-unsafe-eval' must be specified in the CSP if an extension is to use WebAssembly." Source: [Extension Workshop: MV3 migration guide](https://extensionworkshop.com/documentation/develop/manifest-v3-migration-guide/).

**Sandboxed pages (Chrome)**
- Sandboxed pages have their own CSP, which by default includes `'unsafe-eval'`.
- They have no access to extension APIs and can talk to the rest of the extension only through `postMessage`.
- Source: [Chrome: Manifest – sandbox](https://developer.chrome.com/docs/extensions/reference/manifest/sandbox) (updated 2013-05-12).
- Firefox added the `sandbox` manifest key in version 154 ([MDN browser-compat-data, `webextensions/manifest/sandbox.json`](https://github.com/mdn/browser-compat-data/blob/main/webextensions/manifest/sandbox.json)).

**Tauri**
- Tauri's CSP is opt-in, set in the Tauri config. Its docs say: if you use WebAssembly, "add `'wasm-unsafe-eval'` to your `script-src`". Source: [Tauri: CSP](https://v2.tauri.app/security/csp/) (updated 2025-04-07).

**Real wallets using this**
- MetaMask's MV3 Chrome manifest: `"extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; …"`, with a separate `sandbox` CSP that allows `'unsafe-eval'` for `snaps/index.html` ([app/manifest/v3/chrome.json](https://github.com/MetaMask/metamask-extension/blob/main/app/manifest/v3/chrome.json) and [\_base.json](https://github.com/MetaMask/metamask-extension/blob/main/app/manifest/v3/_base.json)).
- The Namada keychain (a Rust→WASM SDK) uses `"extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"` with `"background": {"service_worker": …, "type": "module"}` ([namada-interface apps/extension/src/manifest/v3/\_base.json](https://github.com/namada-net/namada-interface/blob/main/apps/extension/src/manifest/v3/_base.json)).
- Alby (a Lightning wallet) uses the same CSP for its Chrome MV3 build ([src/manifest.json](https://github.com/getAlby/lightning-browser-extension/blob/master/src/manifest.json)).

**Takeaway:** adding `'wasm-unsafe-eval'` is a one-line, well-trodden change. It does not trigger extra review the way `unsafe-eval` would, because `unsafe-eval` isn't allowed at all.

## 2. Remotely hosted code, and what it means for Decoders

**Chrome definition**
- Remotely hosted code is "anything that is executed by the browser that is loaded from someplace other than the extension's own files". The page's examples are JavaScript and WASM.
- It "does not include data or things like JSON or CSS".
- The exceptions are the User Scripts API, `chrome.debugger`, and sandboxed iframes for evaluating strings.
- Source: [Chrome: Deal with remote hosted code violations](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code) (updated 2023-12-13).

**Chrome Web Store policy**
- Source: [Chrome Web Store: Additional requirements for MV3](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements) (updated 2024-04-03).
- §1: external resources may supply data, but "must not contain any logic".
- §1, listed violations:
  - "Including a `<script>` tag that points to a resource that is not within the extension's package"
  - "Using JavaScript's `eval()` method or other mechanisms to execute a string fetched from a remote source"
  - "**Building an interpreter to run complex commands fetched from a remote source, even if those commands are fetched as data**"
- §2: code in contexts isolated from extension APIs, "such as iframes and sandboxed pages", is exempt. But such code is "treated similarly to our policy on communication with external servers", and "it must still be possible to determine the full functionality of your extension".

**Firefox (AMO) policy**
- "Add-ons must be self-contained and not load remote code for execution."
- Minified, bundled or machine-generated code requires a source-code submission that reviewers can rebuild.
- Source: [Extension Workshop: Add-on policies](https://extensionworkshop.com/documentation/publish/add-on-policies/) (updated 2026-04-30).
- The policy says nothing about sandboxed iframes. **(inference)** Do not assume Chrome's sandbox exemption also applies on AMO.

**What this means for Decoders (inference, built on the sources above)**

| Decoder delivery | Web app | Chrome MV3 | Firefox MV3 |
|---|---|---|---|
| Bundled in the package, as Rust compiled into the core or as TS modules | OK | OK | OK |
| WASM or JS fetched from a **Sidechain Server** or registry and run in extension pages or the service worker | Possible, but a security choice | **Banned** | **Banned** |
| Same code, run in a sandboxed iframe with no extension API access | n/a | Policy-exempt, but must stay "determinable"; reviewer discretion | Not covered by policy; risky |
| Purely declarative descriptors (field layouts, labels, formatting) fetched as JSON | OK | Grey zone: fine while it is plain data; becomes a violation if it amounts to an "interpreter … of complex commands" | Probably fine as data |

**Consequences**
- **Extension:** in the extension, adding a Decoder means shipping an extension release, and sidechain developers would wait on the wallet's release cycle. Decoder authors could contribute to the wallet repo, with Decoders bundled at build time. That keeps the dependency to release cadence, not engineering time, but it is still a dependency.
- **Web app:** the web app has no store policy, so it *could* load Decoders at runtime. A Decoder decides what the user sees before signing, though. A remotely loaded Decoder is a remote party controlling the Clear Signing view, so it should be content-pinned (hash/SRI) or signed either way. **(inference)**
- **Declarative Decoders:** a declarative Decoder format, with data describing how to render a Signing Request, is the one path that could be both runtime-loadable and store-compliant. To stay on the "data" side of the Chrome rule, it must stay simple: no loops, no general expressions. **(inference)**

## 3. WASM in the extension's background context

**Chrome lifecycle**
- The background context is a service worker. It is terminated after 30 s of inactivity, when one event or API call takes over 5 min, or when a `fetch()` response takes over 30 s. Events and extension API calls reset the idle timer (Chrome 110+).
- Source: [Chrome: The extension service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle) (updated 2023-05-02).
- **(inference)** Each wake-up re-instantiates the WASM module. Any unlocked key material held in WASM memory is lost on termination, so session state must be persisted (e.g. `chrome.storage.session`) or re-derived. That belongs to the key-storage ticket.

**Modules**
- Static `import` works with `"background": {"type": "module"}`.
- "`import()`, often called a dynamic import, is not supported."
- Source: [Chrome: Service worker basics](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/basics) (updated 2023-05-02).

**No top-level `await`**
- The ServiceWorker spec's Update algorithm says: "If script is null or **Is Async Module** with script's record … is true, then: Invoke Reject Job Promise with job and TypeError". Is Async Module is true when the module or any of its imports has `[[Async]]`, i.e. contains a top-level `await` ([W3C Service Workers spec](https://w3c.github.io/ServiceWorker/), "Update" and "Is Async Module").
- The issue was raised against wasm-bindgen specifically: ESM-integration loading needs top-level `await`, which "has been banned in service workers". Sync XHR is also banned in service workers. Synchronous `new WebAssembly.Module` has a 4 KB limit on the main thread, and whether to apply the same limit to service workers is still an open issue ([w3c/ServiceWorker#1499](https://github.com/w3c/ServiceWorker/issues/1499), open).
- Consequences:
  - Vite's native `.wasm` ESM import "behaves as an async module and requires top-level `await`" ([Vite: Features – WebAssembly](https://vite.dev/guide/features.html#webassembly), Vite 8.3.4).
  - `vite-plugin-wasm` "also need[s] the `vite-plugin-top-level-await` plugin" ([Menci/vite-plugin-wasm README](https://github.com/Menci/vite-plugin-wasm)).
  - **Neither may be used in the Chrome background service worker bundle.**
- **The working pattern** is wasm-bindgen `--target web`, whose default export is an `async init({ module_or_path })` and which also exports `initSync({ module })` ([wasm-bindgen cli-support `js/mod.rs`](https://github.com/wasm-bindgen/wasm-bindgen/blob/main/crates/cli-support/src/js/mod.rs); [Without a bundler example](https://github.com/wasm-bindgen/wasm-bindgen/blob/main/guide/src/examples/without-a-bundler.md)). Register all listeners synchronously at top level, and keep a lazily created `init()` promise that each handler awaits.
- Namada's background does exactly this. It creates `const init = new Promise(async …)` holding `await initSdk(…)` at module scope, with no top-level `await` ([apps/extension/src/background/index.ts](https://github.com/namada-net/namada-interface/blob/main/apps/extension/src/background/index.ts), [sdk/service.ts](https://github.com/namada-net/namada-interface/blob/main/apps/extension/src/background/sdk/service.ts)).

**Firefox**
- "`background.service_worker` is not supported (see Firefox bug 1573659)". Firefox runs MV3 background code as an event page via `background.scripts`.
- Recommended cross-browser manifest: specify **both** `scripts` and `service_worker`. Chrome 121+ ignores `scripts` in MV3; before 121, Chrome refuses to load an MV3 manifest that contains it.
- Source: [MDN: background](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background) (modified 2026-10-14).
- `background.type: "module"` is supported in Chrome 92+ and Firefox 112+ ([MDN browser-compat-data, `background.json`](https://github.com/mdn/browser-compat-data/blob/main/webextensions/manifest/background.json)).
- **(inference)** The Firefox event page is a document, so top-level `await` would technically work there. Use the Chrome-safe pattern everywhere so there is one bundle.

**Offscreen documents (Chrome only)**
- Offscreen documents provide a DOM, allow one document at a time, have no lifetime limit except for `AUDIO_PLAYBACK`, and can use only the `runtime` API. Chrome 109+ ([Chrome: chrome.offscreen](https://developer.chrome.com/docs/extensions/reference/api/offscreen), updated 2026-09-21).
- Signing doesn't need a DOM, so the signing core does not need an offscreen document. **(inference)**

## 4. Toolchain status (wasm-bindgen / wasm-pack)

- The rustwasm GitHub org was sunset in 2025. wasm-bindgen was "transferred to a new wasm-bindgen organization" with new maintainers ([Inside Rust blog, 2025-07-21](https://blog.rust-lang.org/inside-rust/2025/07/21/sunsetting-the-rustwasm-github-org)).
- Current state, checked via the GitHub API on 2026-10-19:
  - [wasm-bindgen/wasm-bindgen](https://github.com/wasm-bindgen/wasm-bindgen) is active; latest release 0.2.129 (2026-09-25).
  - [wasm-bindgen/wasm-pack](https://github.com/wasm-bindgen/wasm-pack) is active; latest release v0.15.0 (2026-05-15).
  - Old docs at rustwasm.github.io may be stale; the guide source lives in the wasm-bindgen repo.
- Targets, from the [deployment guide](https://github.com/wasm-bindgen/wasm-bindgen/blob/main/guide/src/reference/deployment.md):
  - `bundler` (default) assumes WASM-as-ES-module; "the only known bundler known to be fully compatible … is webpack" (Rolldown via a plugin).
  - `web` "can natively be included on a web page … as an ES module".
  - A new `module` target uses source-phase imports, "currently only supported in ESBuild and Node.js 24".
  - **Use `--target web`.**
- **C dependencies:** the obvious crates for an Elements drivechain are [rust-elements](https://github.com/ElementsProject/rust-elements), which depends on `secp256k1-zkp`, and `rust-secp256k1`. Both wrap C libsecp256k1, and the build script special-cases `wasm32` with a bundled sysroot ([secp256k1-sys/build.rs](https://github.com/rust-bitcoin/rust-secp256k1/blob/master/secp256k1-sys/build.rs)).
  - rust-secp256k1's WASM CI runs `CC=clang wasm-pack build` ([contrib/wasm.sh](https://github.com/rust-bitcoin/rust-secp256k1/blob/master/contrib/wasm.sh)).
  - rust-elements CI runs `cargo check --target wasm32-unknown-unknown` ([.github/workflows/rust.yml](https://github.com/ElementsProject/rust-elements/blob/master/.github/workflows/rust.yml)).
  - **Builds need clang with the wasm32 target, not just rustc.** This matters for CI and for Firefox reviewers' rebuilds (§6).
- **Randomness:** `getrandom` on `wasm32-unknown-unknown` needs the `wasm_js` feature, and libraries should not enable it ([getrandom README](https://github.com/rust-random/getrandom)). Enable it only in the `core-wasm` bindings crate. **(inference)**

## 5. Bundle size

- Measure the `foo_bg.wasm` that comes out of wasm-bindgen, not the raw rustc output. Further size work is the usual set: opt-level, LTO, `wasm-opt` ([wasm-bindgen: Optimizing for size](https://github.com/wasm-bindgen/wasm-bindgen/blob/main/guide/src/reference/optimize-size.md)).
- Data points, from npm tarballs fetched 2026-10-19:
  - `tiny-secp256k1@2.2.4` (bitcoinjs, Rust→WASM): `secp256k1.wasm` = **1,242,788 bytes**.
  - `@namada/sdk@0.23.1` (full chain SDK incl. MASP): `sdk_bg.wasm` = **6,283,743 bytes**.
- **(inference)** A signing core for an Elements chain (secp256k1-zkp, BIP32/39, sighash, PSET) should land between those two numbers. It must be measured with a prototype.
- **Where size costs matter (inference):**
  - In the extension, the WASM is read from the local package, so there is no network cost. The cost is compile time on each service worker wake-up and on each popup open.
  - In the web app, it is a download, compressed when served.
- **Vite inlining:** Vite inlines `.wasm` files smaller than `assetsInlineLimit` as base64 ([Vite: Features – WebAssembly](https://vite.dev/guide/features.html#webassembly)). Keep the file as a separate asset so Firefox reviewers can diff it and the MV3 package stays readable.

## 6. Svelte/Vite integration

- **Vite 8.1.0 (2026-06-23) added native direct `.wasm` imports**, following the WASM ESM Integration proposal ([vite PR #21779](https://github.com/vitejs/vite/pull/21779); [Vite CHANGELOG](https://github.com/vitejs/vite/blob/main/packages/vite/CHANGELOG.md)). Older docs telling you to use `vite-plugin-wasm` are now out of date for Vite 8.1+.
- The other options are `?init`, which returns a `WebAssembly.Instance`, and `?url`, which gives an asset URL for manual instantiation ([Vite: Features – WebAssembly](https://vite.dev/guide/features.html#webassembly)).
- **Recommended, because it works in every context (inference):**
  - Build the crate with `wasm-pack build --target web`.
  - Import the generated JS normally.
  - Import the `.wasm` with `?url` and call `init({ module_or_path: url })`.
  - This avoids top-level `await`, so the same code runs in the web app, the popup, and the Chrome service worker.
- **Building the extension:** Vite builds pages well, but a service-worker entry needs its own build (library or IIFE/ES output) with no code-splitting, because dynamic `import()` is unsupported there ([Chrome: Service worker basics](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/basics)). Namada uses webpack for this. I did not evaluate Vite extension frameworks (CRXJS, WXT); that would be a follow-up.
- **Firefox source submission:**
  - Reviewers rebuild from source on a default Ubuntu 24.04 ARM64 box with Node 24.14.0. You must state any toolchain differences, so state Rust, clang and wasm-pack.
  - The rebuilt output must match the submitted one, with "no differences".
  - Build tools must be open source and must run locally.
  - Source: [Extension Workshop: Source code submission](https://extensionworkshop.com/documentation/publish/source-code-submission/).
  - **(inference)** WASM builds need to be reproducible: pinned toolchain, `--locked`, deterministic `wasm-opt`. Committing the built `.wasm` with a build script might also work, but that is untested against AMO review.

## 7. Reusing the crate under Tauri

- Tauri 2 is stable (latest tauri-v2.12.4, 2026-10-14). Tauri 3 is in alpha (v3.0.0-alpha.5, 2026-10-14), per [tauri-apps/tauri releases](https://github.com/tauri-apps/tauri/releases).
- The frontend calls Rust through `#[tauri::command]` and `invoke()`. Arguments and results are serde-serialised, and `async` commands run off the UI thread ([Tauri: Calling Rust](https://v2.tauri.app/develop/calling-rust/), updated 2026-06-08).
- **Two ways to reuse the core (inference):**
  - (a) Run the same `core-wasm` inside the Tauri webview. This needs `'wasm-unsafe-eval'` in the Tauri CSP, and nothing in the Svelte app changes.
  - (b) Call `core` natively through commands. This is faster, can use OS keychains, and keeps secrets out of the webview.
- To keep (b) open:
  - make `core` a plain Rust library (no `wasm-bindgen`, no `js-sys`, no `getrandom/wasm_js`), with a serde-friendly API;
  - put the bindings in thin adapters, `core-wasm` (wasm-bindgen) and later `core-tauri` (commands);
  - on the TS side, put the core behind one interface (`SigningCore`) with a WASM implementation and later an `invoke` implementation.

## Open uncertainties

- **Decoders vs. store policy.** How far a declarative Decoder format can go before Chrome reviewers call it an "interpreter", and whether AMO accepts sandboxed-iframe Decoders, can only be settled empirically or by asking the stores.
- **Real bundle size and cold-start cost** for an Elements signing core (secp256k1-zkp + PSET) after `wasm-opt`: unmeasured. A prototype ticket should measure the `.wasm` size and the time to `init()` inside a woken service worker.
- **Compiled-module caching.** I found no primary source on whether Chrome caches compiled WASM for `chrome-extension://` URLs across service worker restarts.
- **AMO reproducibility of Rust/clang/wasm-opt builds.** Not documented by Mozilla; needs a test submission.
- **Vite 8.1's new native WASM path with wasm-bindgen output.** The new path is weeks old. Combining its WASM ESM integration with wasm-bindgen's `bundler` target is untested here, so prefer `--target web` + `?url`.
