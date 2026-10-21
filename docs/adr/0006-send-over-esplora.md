# Send over Esplora: the Chain Module builds, explicit only, and spent coins are held

Over Esplora no server builds transfers (ADR 0002), so the wallet builds its own Send. The wallet gathers the account's coins from `/address/:a/utxo`. The Slot's Chain Module builds the transfer as a pure capability: `build_transfer(order, starter)` takes the coins, one or more outputs, a fee rate and a change index, and returns an unsigned PSET plus the coins it spends. The module's own Decoder then explains the PSET in the normal approval window, where the requester is "This wallet (Send on <chain name>)". After approval the module signs it and finalizes it (`finalize`), and the wallet broadcasts it with `POST /tx`. The Clear View must show the payments asked for, in order, and otherwise only outputs back to the wallet; anything else is a wallet bug and is refused before the user sees it.

The rules:

- **Unconfidential destinations only.** The wallet is explicit-only (the Decoder refuses blinding data), so a confidential address is refused with a message that gives its unconfidential form. Paying a confidential address's script without blinding would quietly break what its owner expects.
- **Coins: confirmed, plus trusted change.** Coin selection offers confirmed explicit outputs, plus outputs of unconfirmed transactions that history marks trusted (Bitcoin Core's `IsTrusted`: every input the wallet's own, every parent confirmed or trusted). When that history is `partial`, only confirmed coins count. Their sum per asset is **Spendable**, which the Send page shows. Selection is largest first, per asset. The coins' values and assets come from the server; the module derives their scripts itself. A server that lies about either gets a transaction Elements rejects, not a loss: Elements has no implicit fee, since each asset's inputs must equal its outputs, and the segwit-v0 sighash commits to each input's value.
- **Fee:** Deposit's rate (`feeRate`: the 6-block estimate, never below the 1008-block one or 0.1 sat/vB, and 1 sat/vB when `/fee-estimates` is `{}`), paid in the policy asset. Sending another asset still needs policy-asset coins for the fee.
- **Dust:** Elements Core's `GetDustThreshold` at its `DUST_RELAY_TX_FEE` of 100 sat/kvB, for an explicit output of any asset (14 base units for an explicit P2WPKH output). A payment below it is refused. Policy-asset change below it goes to the fee. Change in another asset can't go to the fee, so selection adds coins until that change clears the threshold, or refuses.
- **Change:** one change address for every asset, the first of the 20 watched change addresses (`/1/0..19`) that nothing has paid. When all 20 are used, change goes to `/1/19` again: reusing an address costs privacy, but refusing would lock funds behind a window the user can't widen.
- **Held coins.** A broadcast Send's spent coins are kept in `storage.local` with the tip height at broadcast, and left out of coin selection. The server may still list them before it has indexed the spend. An entry is dropped once its transaction confirms. It is also dropped, releasing the coins, once the server doesn't know the transaction (404) and the tip is at least 6 blocks past the broadcast. Blocks, not minutes, because Slot 24's blocks depend on the main chain's mining and can stall.

Every output in `build_transfer`'s order is `{ asset, amount, to: { address } }`. `to` is tagged so that later outputs can pay a script or carry data (a Withdrawal's burn, a dApp's OP_RETURN) without changing the interface. The `/v1` `TransferOrder` takes the same list.

## Considered Options

- **Blind outputs (confidential transactions):** not now. It needs blinding in the module, a Decoder that can explain blinded outputs, and the wallet's View Key: a project of its own.
- **Confirmed coins only:** rejected. Right after a Send, the next one would fail until the change confirmed.
- **Hold spent coins for the session only:** rejected. Closing the browser would forget a pending Send's coins while the server might still list them.
- **Release held coins after a time instead of blocks:** rejected. A stalled chain would release coins whose spend is still pending.

## Consequences

- Known edge case: if the server evicts a held Send that another node keeps and later mines, a Send built after the release may spend the same coins. One of the two is refused; nothing is lost.
- Spends a dApp signs through `signTransaction` and broadcasts itself aren't held: the wallet never sees the broadcast. Once the server has the transaction, its mempool view leaves the coins out of `/utxo`.
- Gaps, each for a later issue: a dApp asking the wallet to fund outputs (#39); completing a PSET someone else started (swaps), which needs non-default sighashes; issuance; choosing coins by hand; sending the maximum; a fee picker; RBF.
