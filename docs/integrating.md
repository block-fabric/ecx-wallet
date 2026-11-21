# Integrating a Sidechain App with ECX Wallet

For developers of a site that wants its users to pay, trade or sign with ECX Wallet. The methods, Grants and error codes are in [The Provider](how-it-works.md#the-provider); this page covers how your site finds the wallet and what it must allow.

## Where your users' wallet can be

| Where | How your site reaches it | What it needs from you |
|---|---|---|
| **The browser extension** | It announces a Provider on every page. | Nothing. |
| **A web wallet that opened your site** (ECX Wallet's Apps view, or any other web wallet that speaks the [web wallet protocol](web-wallet-protocol.md)) | Your page is in its frame and talks to `window.parent`. | Allow framing (below). Requests need no click. |
| **The web wallet in a popup** (no extension, site opened directly) | Your site opens the web wallet's `#/provider` page. | The first request must come from a click, or the browser blocks the popup (4900). |

All three answer the same `request({ method, params })` calls and `grantChanged` event.

## Finding the wallet

### With `client`

`client.js` handles all three. A web wallet built from this repo serves it, bundled, at `/client.js`; import it from there, or host your own copy:

```js
import { discoverProviders } from "<web wallet URL>/client.js";

// A framing wallet first, then extensions, else the web wallet at `webWallet` in a popup.
const [wallet] = await discoverProviders({ webWallet: "<web wallet URL>" });
```

`wallet.info.name` says which one it is: the extension's name, `Wallet at <origin>` for a wallet framing your page, or `ECX Wallet (web)` for the popup. Loading it from the wallet's site needs that origin in your `script-src`. The file changes with each deploy, so don't pin it with SRI.

### Without `client`

Nothing to load. Each case is a few lines.

**The extension** answers an event, as EIP-6963 does for Ethereum wallets:

```js
function extensionWallets(timeoutMs = 200) {
  const found = new Map();
  const onAnnounce = (event) => found.set(event.detail.info.uuid, event.detail);
  window.addEventListener("ecx:announceProvider", onAnnounce);
  window.dispatchEvent(new Event("ecx:requestProvider"));
  return new Promise((resolve) => setTimeout(() => {
    window.removeEventListener("ecx:announceProvider", onAnnounce);
    resolve([...found.values()]); // each { info: { uuid, name, icon, rdns }, provider }
  }, timeoutMs));
}
```

**A web wallet framing your page:** paste `framingWallet()` from [the protocol doc](web-wallet-protocol.md#the-app-side-framed-without-client). It resolves to a provider, or `null` when no wallet frames the page.

**The popup** needs more (opening the window, waiting for it, noticing it close): use `client` for it, or follow the [protocol doc](web-wallet-protocol.md).

## Letting web wallets open your site

A web wallet can only show your site if your site lets it be framed. Name the wallets you support by their origins:

```http
Content-Security-Policy: frame-ancestors https://wallet.example https://other-wallet.example
```

Prefer this to `frame-ancestors *`. Framed, your page treats whatever page frames it as its wallet. With `*`, any site can frame yours and answer as a wallet:

- **A rogue wallet.** It can hand your page addresses of its own choosing, so your page shows the attacker's address as "your address", or credits it on your server. It can also pose as a wallet to phish the user's password or recovery phrase.
- **Clickjacking.** It can lay your page under its own, so a click meant for it lands on yours. That matters if one click on your site can act on a logged-in session. Approvals happen in the wallet, not on your page.

Whichever you send, show the user which wallet your page is using: `discoverProviders()` names a framing wallet by its origin (`info.name`, `Wallet at <origin>`). Don't send `X-Frame-Options: DENY` or `SAMEORIGIN`.

Inside a wallet's frame, your site is third-party:

- **Storage** (localStorage, IndexedDB) is separate from your own tab. What a user saved on your site directly isn't there.
- **Cookies** need `SameSite=None; Secure; Partitioned`. Brave, Firefox and Safari block or partition the rest. Connecting to the wallet uses no cookies.
- Your page can't navigate the wallet's tab. In ECX Wallet, links you open in a new tab open normally.

## A typical flow

```js
// On load: no window opens, and it works while the wallet is locked.
const grant = await wallet.provider.request({ method: "getGrant" });

// From a click: ask for a Grant (the user approves in the wallet), then for an address.
await wallet.provider.request({ method: "connect", params: { slots: [46], methods: ["getAddresses", "sendTransfer"] } });
const [{ address }] = await wallet.provider.request({ method: "getAddresses", params: { slot: 46 } });

// Revoked on the wallet's Grants screen, or by `disconnect`: back to "Connect".
wallet.provider.on("grantChanged", (scope) => { if (scope === null) showConnect(); });
```

A request the user turns down fails with `code` 4001; show it as a choice, not an error. Slots: Flush is 46 on mainnet (99 on betanet). The other methods (`sendTransfer`, `sendAction`, `signTransaction`, `suggestAsset`) and every error code are in [The Provider](how-it-works.md#the-provider).

**Flush DEX sites** that use the extension's `window.flush` (`flush_requestAddress`, `flush_submit({ uri })`) get no `window.flush` inside a web wallet. There, call `getAddresses({ slot: 46 })` and `sendAction({ slot: 46, action: uri })`, with a Grant for `getAddresses` and `sendTransfer`: `connect({ slots: [46], methods: ["getAddresses", "sendTransfer"] })`. A `sendTransfer` Grant also covers `sendAction`, which has no Grant of its own; asking for one fails with 4200 (see [ADR 0016](adr/0016-flush-actions-through-window-flush.md)).

**Sidepot sites** (Slot 88; [ADR 0021](adr/0021-sidepot-entries-in-main-chain-data-transactions.md)) use the same three calls. The account is the wallet's; the site reads the game from Sidepot's server and hands the wallet each move as a `sidepot:` link:

```js
await wallet.provider.request({ method: "connect", params: { slots: [88], methods: ["getAddresses", "sendTransfer"] } });

// The game account: `address` is "spot:<64 hex>", `publicKey` the same 32-byte x-only key (not a 33-byte compressed key).
const [{ address, publicKey }] = await wallet.provider.request({ method: "getAddresses", params: { slot: 88 } });
const account = await (await fetch(`https://sidepot.cash/api/account/${publicKey}`)).json(); // { balance_sats, keys, nonce } or null
const state = await (await fetch("https://sidepot.cash/api/state")).json();

// A buy: the wallet signs the entry, sends it in a main-chain transaction and answers that transaction's txid.
const action = `sidepot:buy?round=${state.round}&keys=3&max_price=${state.price_sats}&nonce=${(account?.nonce ?? 0) + 1}&expires=${state.tip_clock + 3}`;
const { txid } = await wallet.provider.request({ method: "sendAction", params: { slot: 88, action } });
```

`sidepot:cashout?amount=<sats, 0 = all>&dest=<40 hex>&nonce=<u64>&expires=<u32>` cashes out the same way. `dest` is a Sidepot sidechain address's 20 bytes; the wallet has one of its own, which the user copies from Sidepot's screen in the wallet (in base58: decode it to those 20 bytes), and the approval says whether a cashout pays it ([ADR 0022](adr/0022-sidepot-coins-an-address-of-the-starters-and-spends-in-the-nodes-format.md)). `getAddresses` doesn't answer it. The user funds the account in the wallet, with a Deposit to Slot 88; a site can show `address` as where it goes. The wallet shows every field of the link before it signs, and refuses a link with a missing, repeated or unknown parameter (-32602). The link's grammar and what the approval shows are in [sendAction on Sidepot](how-it-works.md#sendaction-on-sidepot).

## Trying it

`pnpm demo` serves a demo app at `http://localhost:5180/` that does all of the above. To try framing against a wallet built from this repo, serve the web build (`pnpm build:web`, then `app/build-web` with its `_headers`) on another origin, such as `http://127.0.0.1:5300`. Open its Apps view, and enter `localhost:5180/?wallet=http://127.0.0.1:5300/`. The web wallet frames pages on `localhost` too, so you can try your own site from your machine.
