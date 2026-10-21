<script lang="ts">
  // PROTOTYPE, throw away. Variant B, "All chains, drill in": a portfolio list of every chain on
  // one screen, a bottom tab bar (Wallet / Activity / Grants), and a chain's detail one tap away.
  // Activity merges every chain's history. Units stay as today: sats and hex asset ids.
  import type { HistoryEntry } from "$lib/background";
  import { shortAsset } from "$lib/asset";
  import ProtoIcon from "./ProtoIcon.svelte";
  import { assetsOf, depositState, grouped, kindOf, readAt, shortTxid, when, type ProtoChain } from "./fixtures";

  let { chains }: { chains: ProtoChain[] } = $props();

  let tab = $state<"wallet" | "activity" | "grants">("wallet");
  /** The chain drilled into, on the Wallet tab. */
  let open = $state<ProtoChain["id"] | undefined>(undefined);
  /** The Receive screen, and for which chain. */
  let receiving = $state<ProtoChain["id"] | undefined>(undefined);
  let copied = $state(false);

  const detail = $derived(chains.find((c) => c.id === open));
  const receiveChain = $derived(chains.find((c) => c.id === receiving));
  const pendingDeposits = $derived(chains.flatMap((c) => c.deposits ?? []));

  /** Every chain's history, newest first; unconfirmed on top. */
  const feed = $derived(
    chains
      .flatMap((c) => c.history.map((entry) => ({ chain: c, entry })))
      .sort((x, y) => (y.entry.time ?? Infinity) - (x.entry.time ?? Infinity)),
  );

  const unit = (asset: string) => (asset === "" ? "sats" : undefined);

  function copy(address: string) {
    navigator.clipboard.writeText(address).catch(() => {});
    copied = true;
    setTimeout(() => (copied = false), 1500);
  }

  const entryState = (e: HistoryEntry) => (e.confirmed ? undefined : e.trusted ? "Pending" : "Unconfirmed");
</script>

{#snippet avatar(c: ProtoChain)}
  <span class="chain-avatar" class:slot={c.id !== "l1"}>{c.id === "l1" ? "e" : c.id}</span>
{/snippet}

{#snippet amount(asset: string, value: string)}
  <span class="mono-num">{grouped(value)}</span>
  {#if unit(asset)}<span class="muted small">{unit(asset)}</span>{:else}<code class="muted tiny" title={asset}>{shortAsset(asset)}</code>{/if}
{/snippet}

{#snippet activityRow(c: ProtoChain, entry: HistoryEntry, showChain: boolean)}
  {@const kind = kindOf(entry)}
  {@const state = entryState(entry)}
  <li class="row">
    <span class="activity-icon {kind.icon}">
      <ProtoIcon name={kind.icon === "in" ? "receive" : kind.icon === "out" ? "send" : kind.icon} size={16} />
    </span>
    <span class="col grow">
      <span class="line">
        <strong>{kind.label}</strong>
        {#if showChain}<span class="tag">{c.name}</span>{/if}
      </span>
      <span class="muted tiny">
        {#if state}<span class="badge" class:warn={state === "Unconfirmed"}>{state}</span>{:else if entry.time}{when(entry.time)}{/if}
        · <code>{shortTxid(entry.txid)}</code>
      </span>
    </span>
    <span class="col end">
      {#each entry.amounts as a (a.asset)}
        <span class="line" class:in={!a.amount.startsWith("-")}>{a.amount.startsWith("-") ? "" : "+"}{@render amount(a.asset, a.amount)}</span>
      {/each}
      {#if entry.hidden}<span class="muted tiny">+ hidden</span>{/if}
    </span>
  </li>
{/snippet}

<div class="b">
  <div class="content">
    {#if receiveChain}
      <header>
        <button class="icon" aria-label="Back" onclick={() => (receiving = undefined)}><ProtoIcon name="back" /></button>
        <span class="title">Receive</span>
      </header>
      <div class="segmented">
        {#each chains as c (c.id)}
          <button class:on={c.id === receiveChain.id} onclick={() => (receiving = c.id)}>{c.name}</button>
        {/each}
      </div>
      <div class="qr"><ProtoIcon name="qr" size={150} /><span class="tiny">QR code (library to vendor)</span></div>
      <code class="address">{receiveChain.address}</code>
      <button class="primary block" onclick={() => copy(receiveChain.address)}>
        <ProtoIcon name={copied ? "check" : "copy"} />{copied ? "Copied" : "Copy address"}
      </button>
      <p class="notice small"><ProtoIcon name="warning" /><span>Only send {receiveChain.name} assets (<code>{receiveChain.chain}</code>) to this address.</span></p>
    {:else if tab === "wallet" && detail}
      <header>
        <button class="icon" aria-label="Back" onclick={() => (open = undefined)}><ProtoIcon name="back" /></button>
        {@render avatar(detail)}
        <span class="title">{detail.name}</span>
        <span class="chip">{detail.chain}</span>
      </header>

      <section class="card">
        {#if detail.shown.error}
          <p class="error small">{detail.shown.report ? "Couldn't refresh the balance" : "Balance unavailable"}: {detail.shown.error}</p>
        {/if}
        {#each assetsOf(detail.shown) as { asset, amount: value, unconfirmed } (asset)}
          <div class="balance-line">
            <span class="big">{grouped(value)}</span>
            {#if unit(asset)}<span class="muted">{unit(asset)}</span>{:else}<span class="muted small">asset <code title={asset}>{shortAsset(asset)}</code></span>{/if}
          </div>
          {#if unconfirmed}<span class="badge warn">+{grouped(unconfirmed)}{asset === "" ? " sats" : ""} unconfirmed</span>{/if}
        {/each}
        {#if detail.shown.report}
          <p class="reported">Reported by {detail.shown.report.server}. This wallet doesn't verify it.</p>
          {#if detail.shown.refreshing}
            <p class="muted tiny line"><span class="spinner"></span>Last read at {readAt(detail.shown.report.readAt)}; refreshing…</p>
          {/if}
        {/if}
      </section>

      <nav class="tiles">
        {#if detail.id !== "l1"}
          <a class="button tile" class:off={!detail.canSend} href="#/send/{detail.id}"><ProtoIcon name="send" />Send</a>
        {/if}
        <button class="tile" onclick={() => (receiving = detail.id)}><ProtoIcon name="receive" />Receive</button>
        <a class="button tile" href="#/deposit/24"><ProtoIcon name="deposit" />{detail.id === "l1" ? "Deposit to Slot 24" : "Deposit from eCash"}</a>
      </nav>

      {#if detail.deposits?.length}
        <section class="card">
          <h2>Deposits from eCash</h2>
          {#each detail.deposits as d (d.txid)}
            <div class="col">
              <strong>{grouped(d.value)} sats</strong>
              <span class="small">{depositState(d)}</span>
            </div>
          {/each}
        </section>
      {/if}

      <section class="col">
        <h2>Recent activity</h2>
        <ul>
          {#each detail.history.slice(0, 3) as entry (entry.txid)}
            {@render activityRow(detail, entry, false)}
          {/each}
        </ul>
        <button class="link" onclick={() => ((tab = "activity"), (open = undefined))}>See all activity</button>
      </section>
    {:else if tab === "wallet"}
      <header>
        <span class="title">Wallet</span>
        <button class="small-button"><ProtoIcon name="lock" size={16} /> Lock</button>
      </header>
      <p class="muted tiny line"><span class="dot"></span>Unlocked. Locks itself after 15 minutes without use.</p>

      <div class="quick">
        <button class="quick-button" onclick={() => (receiving = "l1")}><ProtoIcon name="receive" />Receive</button>
        <a class="button quick-button" href="#/send/24"><ProtoIcon name="send" />Send</a>
        <a class="button quick-button" href="#/deposit/24"><ProtoIcon name="deposit" />Deposit</a>
      </div>

      <section class="col">
        <h2>Chains</h2>
        <ul class="chains card">
          {#each chains as c (c.id)}
            {@const assets = assetsOf(c.shown)}
            <li>
              <button class="chain-row" onclick={() => (open = c.id)}>
                {@render avatar(c)}
                <span class="col grow">
                  <strong>{c.name}</strong>
                  <span class="mono muted tiny">{c.chain}</span>
                </span>
                <span class="col end">
                  {#if assets[0]}
                    <span class="line">
                      <span class="mono-num">{grouped(assets[0].amount)}</span>
                      {#if assets[0].asset === ""}<span class="muted small">sats</span>{/if}
                    </span>
                    {#if assets[0].asset !== ""}<code class="muted tiny" title={assets[0].asset}>{shortAsset(assets[0].asset)}</code>{/if}
                    {#if assets[0].unconfirmed}
                      <span class="tiny warn-text">+{grouped(assets[0].unconfirmed)} unconfirmed</span>
                    {:else if assets.length > 1}
                      <span class="muted tiny">+{assets.length - 1} more asset{assets.length > 2 ? "s" : ""}</span>
                    {/if}
                    {#if c.shown.refreshing}<span class="muted tiny">refreshing…</span>{/if}
                  {:else if c.shown.error}
                    <span class="err small">Couldn't reach</span>
                  {/if}
                </span>
                <ProtoIcon name="forward" size={16} />
              </button>
            </li>
          {/each}
        </ul>
        <p class="muted tiny">Balances are as each chain's server reports them. This wallet doesn't verify them.</p>
      </section>

      {#if pendingDeposits.length}
        <button class="banner" onclick={() => (open = 24)}>
          <span class="spinner"></span>
          <span class="grow">{pendingDeposits.length} Deposit{pendingDeposits.length > 1 ? "s" : ""} to Slot 24 in progress</span>
          <ProtoIcon name="forward" size={16} />
        </button>
      {/if}
    {:else if tab === "activity"}
      <header><span class="title">Activity</span></header>
      <ul>
        {#each feed as { chain, entry } (entry.txid)}
          {@render activityRow(chain, entry, true)}
        {/each}
      </ul>
      <p class="muted tiny">Reported by each chain's server. This wallet doesn't verify it.</p>
    {:else}
      <header><span class="title">Grants</span></header>
      <p class="muted small">(The real Grants screen would go here.)</p>
    {/if}
  </div>

  {#if receiving === undefined}
    <nav class="tabbar">
      <button class:on={tab === "wallet"} onclick={() => ((tab = "wallet"), (open = undefined))}><ProtoIcon name="wallet" />Wallet</button>
      <button class:on={tab === "activity"} onclick={() => (tab = "activity")}><ProtoIcon name="activity" />Activity</button>
      <button class:on={tab === "grants"} onclick={() => (tab = "grants")}><ProtoIcon name="grants" />Grants</button>
    </nav>
  {/if}
</div>

<style>
  .b {
    display: flex;
    flex-direction: column;
    min-height: 100%;
  }
  .content {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 12px 16px 80px;
  }
  header {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 40px;
  }
  .title {
    flex: 1;
    font-size: 1.2rem;
    font-weight: 700;
  }
  .icon {
    min-height: 32px;
    width: 32px;
    padding: 0;
    margin-left: -6px;
    border: none;
    border-radius: 50%;
    background: none;
  }
  .chain-avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 34px;
    height: 34px;
    border-radius: 10px;
    background: var(--accent);
    color: var(--on-accent);
    font-weight: 700;
    font-size: 0.85rem;
  }
  .chain-avatar.slot {
    background: #7b4fd6;
    color: #fff;
  }
  .quick {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
  }
  .quick-button {
    flex-direction: column;
    gap: 4px;
    min-height: 62px;
    padding: 8px;
    border-radius: var(--radius);
    font-size: 0.8rem;
  }
  .chains {
    padding: 4px;
    gap: 0;
  }
  .chains li + li {
    border-top: 1px solid var(--border);
  }
  .chain-row {
    width: 100%;
    justify-content: flex-start;
    gap: 12px;
    min-height: 64px;
    padding: 8px 10px;
    border: none;
    background: none;
    text-align: left;
    font-weight: 400;
    color: var(--text);
  }
  .col {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .end {
    flex: none;
    align-items: flex-end;
    text-align: right;
  }
  .grow {
    flex: 1;
    min-width: 0;
  }
  .line {
    display: flex;
    align-items: baseline;
    gap: 4px;
  }
  p.line {
    align-items: center;
    gap: 6px;
  }
  .mono-num {
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--ok);
  }
  .banner {
    justify-content: flex-start;
    gap: 10px;
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 8%, var(--surface));
    font-size: 0.85rem;
    text-align: left;
  }
  .balance-line {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .big {
    font-size: 1.6rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }
  .tiles {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(0, 1fr));
    gap: 8px;
  }
  .tile {
    flex-direction: column;
    gap: 6px;
    min-height: 70px;
    padding: 8px;
    border-radius: var(--radius);
    font-size: 0.78rem;
    text-align: center;
    line-height: 1.2;
  }
  .tile.off {
    opacity: 0.45;
    pointer-events: none;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 0;
    border-bottom: 1px solid var(--border);
  }
  .activity-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 34px;
    height: 34px;
    border-radius: 50%;
    background: var(--surface-2);
  }
  .activity-icon.in,
  .in {
    color: var(--ok);
  }
  .activity-icon.deposit {
    color: var(--accent);
  }
  .tag {
    padding: 0 6px;
    border-radius: 4px;
    background: var(--surface-2);
    color: var(--muted);
    font-size: 0.7rem;
    font-weight: 600;
  }
  .badge {
    padding: 0 6px;
    font-size: 0.7rem;
  }
  .badge.warn {
    background: var(--warn-bg);
    color: var(--warn);
  }
  .warn-text {
    color: var(--warn);
  }
  .err {
    color: var(--danger);
  }
  .link {
    align-self: flex-start;
    min-height: 0;
    padding: 4px 0;
    border: none;
    background: none;
    color: var(--accent);
    font-size: 0.85rem;
  }
  .segmented {
    display: flex;
    padding: 3px;
    border-radius: 999px;
    background: var(--surface-2);
  }
  .segmented button {
    flex: 1;
    min-height: 32px;
    border: none;
    border-radius: 999px;
    background: none;
    font-size: 0.85rem;
  }
  .segmented button.on {
    background: var(--surface);
    box-shadow: var(--shadow);
  }
  .qr {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    align-self: center;
    padding: 16px;
    border-radius: var(--radius);
    background: #fff;
    color: #111;
  }
  .address {
    padding: 10px 12px;
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    font-size: 0.75rem;
    text-align: center;
  }
  .tabbar {
    /* Fixed: in the popup, to the window; in the prototype frame, to the frame. */
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    border-top: 1px solid var(--border);
    background: var(--surface);
  }
  .tabbar button {
    flex-direction: column;
    gap: 2px;
    min-height: 56px;
    border: none;
    border-radius: 0;
    background: none;
    color: var(--muted);
    font-size: 0.72rem;
  }
  .tabbar button.on {
    color: var(--accent);
  }
  .tiny {
    font-size: 0.75rem;
  }
</style>
