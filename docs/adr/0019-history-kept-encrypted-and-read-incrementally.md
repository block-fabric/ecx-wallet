# History kept encrypted, and read only where it changed

Activity read every chain's history from scratch: on Flush and eCash, each of the 40 watched addresses' transaction lists (up to ~28 KB each), older pages, then the raw transaction behind each token coin. The last one was kept only for the session (`storage.session`), forgotten on lock and when the browser closed. Louis: "loading transactions takes a while. are we able to create a local cache that would display what it knows and only pull whats different?" (2026-10-29).

- **Kept across sessions, encrypted.** Each chain's last history, with what its next read starts from, is kept in `storage.local` (`history:<chain>:<server>`, `wallet/src/history-store.ts`) as AES-256-GCM under a key the vault derives from its own while unlocked: HKDF-SHA-256 of the vault key (`vault.historyKey`). It names the wallet's addresses and every transaction, so nothing of it is readable at rest; locked, nothing reads or writes it. A new wallet or password has another key: what it can't decrypt counts as never written, and its first read replaces it. The store's name is the AAD, so one chain's can't be read as another's. Deriving the key doesn't count as activity for the auto-lock. Past 4 MB of JSON a chain's history isn't kept.
- **Shown at once.** Activity shows this session's last history, else the kept one, marked "Last read at …; refreshing…", while it reads again.
- **Read only where it changed** (Esplora, `addressHistory` with the last read's `AddressSync`). For each address, its counts first (`/address/:a`): the same as last time, and nothing it holds within `REORG_DEPTH` (6) blocks of the tip or unconfirmed, and the kept list stands. Else its first page; when that page is full (25 confirmed), the kept ones after its oldest follow, if that one is kept and settled, no txid repeats, and the counts say nothing is missing between them. Anything else is read whole, as before. Statuses are kept as the server listed them and settled again on each read, against the tip. What the module read of a token transaction (`outputTokens`) is kept too: a transaction never changes.
- **Synced after unlock.** The background reads every chain that's on right after an unlock (`syncHistories`), as unattended reads, so Activity has it when opened.
- **One read at a time per chain.** A caller arriving while a read is under way (a page, the background, a Send's re-read) gets the next one, started once it's done and shared by everyone asking meanwhile: a read under way may have started before what they ask for.

Not kept: balances, unspent outputs and anything a transaction is built from, which are read fresh as before. Trade outcomes keep ADR 0017/0018's rules.

## Consequences

- An unchanged address costs one small request instead of its list; a quiet wallet's refresh reads no list at all.
- A reorg deeper than `REORG_DEPTH` that kept an address's counts would leave its kept list stale until the counts move. The next read whole (a new wallet, password, or server) corrects it.
- The kept history is as private as the vault: readable only with the password. Locking doesn't delete it.
