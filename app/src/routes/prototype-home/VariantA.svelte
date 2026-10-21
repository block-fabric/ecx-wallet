<script lang="ts">
  // PROTOTYPE, throw away. Variant A, "One chain at a time": MetaMask's shape. A chain switcher up
  // top, one big balance in whole ECX, round action buttons, Assets / Activity tabs. Receive is a
  // sheet with a QR code. Assets get names from an imagined Chain Entry field.
  import Mark from "$lib/Mark.svelte";
  import type { HistoryEntry } from "$lib/background";
  import ProtoIcon from "./ProtoIcon.svelte";
  import {
    ASSET_NAMES,
    assetsOf,
    coins,
    depositState,
    grouped,
    kindOf,
    readAt,
    shortAddress,
    shortTxid,
    when,
    type ProtoChain,
  } from "./fixtures";
  import { shortAsset } from "$lib/asset";

  let { chains }: { chains: ProtoChain[] } = $props();

  let selected = $state<ProtoChain["id"]>("l1");
  let tab = $state<"assets" | "activity">("assets");
  let switching = $state(false);
  let menu = $state(false);
  let receiving = $state(false);
  let copied = $state(false);

  const chain = $derived(chains.find((c) => c.id === selected) ?? chains[0]);
  const assets = $derived(assetsOf(chain.shown));
  const main = $derived(assets[0]);
  const named = (asset: string) => ASSET_NAMES[asset];

  function amountIn(asset: string, amount: string): string {
    const name = named(asset);
    return name ? `${coins(amount, name.decimals)} ${name.ticker}` : grouped(amount);
  }

  function copy() {
    navigator.clipboard.writeText(chain.address).catch(() => {});
    copied = true;
    setTimeout(() => (copied = false), 1500);
  }

  function pick(id: ProtoChain["id"]) {
    selected = id;
    switching = false;
  }

  const entryState = (e: HistoryEntry) => (e.confirmed ? undefined : e.trusted ? "Pending" : "Unconfirmed");
</script>

{#snippet avatar(c: ProtoChain, size = 28)}
  <span class="chain-avatar" class:slot={c.id !== "l1"} style:width="{size}px" style:height="{size}px">
    {c.id === "l1" ? "e" : c.id}
  </span>
{/snippet}

{#snippet tokenAvatar(asset: string)}
  {@const name = named(asset)}
  <span class="token-avatar" class:unknown={!name}>{name ? name.ticker[0] : "?"}</span>
{/snippet}

<div class="a">
  <header>
    <Mark size={26} />
    <button class="switch" onclick={() => (switching = !switching)} aria-expanded={switching}>
      {@render avatar(chain, 20)}
      <span>{chain.name}</span>
      <ProtoIcon name="chevron" size={16} />
    </button>
    <span class="spacer"></span>
    <button class="icon" aria-label="Lock" title="Lock"><ProtoIcon name="lock" /></button>
    <button class="icon" aria-label="More" onclick={() => (menu = !menu)}><ProtoIcon name="more" /></button>
    {#if menu}
      <div class="menu card">
        <a href="#/grants" class="menu-row"><ProtoIcon name="grants" /> Grants</a>
        <button class="menu-row"><ProtoIcon name="lock" /> Lock now</button>
      </div>
    {/if}
  </header>

  {#if switching}
    <div class="dropdown card">
      <h2>Chains</h2>
      {#each chains as c (c.id)}
        {@const first = assetsOf(c.shown)[0]}
        <button class="chain-row" class:active={c.id === chain.id} onclick={() => pick(c.id)}>
          {@render avatar(c)}
          <span class="stack-tight">
            <strong>{c.name}</strong>
            <span class="mono muted tiny">{c.chain}</span>
          </span>
          <span class="right small">
            {#if first}{amountIn(first.asset, first.amount)}{:else if c.shown.error}<span class="err">Unavailable</span>{/if}
          </span>
        </button>
      {/each}
    </div>
  {/if}

  <p class="lock-note"><span class="dot"></span>Unlocked. Locks itself after 15 minutes without use.</p>

  <section class="hero">
    {#if main}
      <div class="big amount">{amountIn(main.asset, main.amount)}</div>
      {#if named(main.asset)}<div class="muted small">{grouped(main.amount)} sats</div>{/if}
      {#if main.unconfirmed}
        <span class="pill warn">+{grouped(main.unconfirmed)} sats unconfirmed</span>
      {/if}
    {:else if chain.shown.error}
      <div class="big amount muted">—</div>
    {/if}
    {#if chain.shown.error}
      <p class="error small">{chain.shown.report ? "Couldn't refresh the balance" : "Balance unavailable"}: {chain.shown.error}</p>
    {/if}
    {#if chain.shown.report}
      <p class="reported-inline">Reported by {chain.shown.report.server}. This wallet doesn't verify it.</p>
      {#if chain.shown.refreshing}
        <p class="muted tiny row"><span class="spinner"></span>Last read at {readAt(chain.shown.report.readAt)}; refreshing…</p>
      {/if}
    {/if}
  </section>

  <nav class="actions">
    {#if chain.id !== "l1"}
      <a class="action" class:off={!chain.canSend} href="#/send/{chain.id}">
        <span class="circle"><ProtoIcon name="send" /></span>Send
      </a>
    {/if}
    <button class="action" onclick={() => (receiving = true)}>
      <span class="circle"><ProtoIcon name="receive" /></span>Receive
    </button>
    <a class="action" href="#/deposit/24">
      <span class="circle"><ProtoIcon name="deposit" /></span>{chain.id === "l1" ? "To Slot 24" : "Deposit"}
    </a>
  </nav>

  {#if chain.deposits?.length}
    <section class="deposits card">
      <h2>Deposits from eCash</h2>
      {#each chain.deposits as d (d.txid)}
        <div class="deposit">
          <div class="deposit-head">
            <strong>{grouped(d.value)} sats</strong>
            {#if d.state === "notFound" || d.state === "unavailable"}
              <button class="small-button">Stop tracking</button>
            {/if}
          </div>
          {#if d.state === "confirming"}
            <div class="bar"><span style:width="{d.confirmations}%"></span></div>
          {/if}
          <span class="small" class:err={d.state === "notFound"}>{depositState(d)}</span>
        </div>
      {/each}
      <p class="muted tiny">A Deposit takes 100 eCash blocks, then the chain's operator credits it. Withdrawals back take months.</p>
    </section>
  {/if}

  <div class="tabs" role="tablist">
    <button role="tab" class:on={tab === "assets"} onclick={() => (tab = "assets")}>Assets</button>
    <button role="tab" class:on={tab === "activity"} onclick={() => (tab = "activity")}>Activity</button>
  </div>

  {#if tab === "assets"}
    <ul class="list">
      {#each assets as { asset, amount, unconfirmed } (asset)}
        {@const name = named(asset)}
        <li class="row">
          {@render tokenAvatar(asset)}
          <span class="stack-tight grow">
            <strong>{name ? name.ticker : "Unknown asset"}</strong>
            <span class="muted tiny">{#if name}{name.name}{:else}<code title={asset}>{shortAsset(asset)}</code>{/if}</span>
          </span>
          <span class="stack-tight right">
            <strong>{name ? coins(amount, name.decimals) : grouped(amount)}</strong>
            {#if unconfirmed}<span class="tiny warn-text">+{grouped(unconfirmed)} unconf.</span>{/if}
          </span>
        </li>
      {:else}
        <li class="muted small empty">{chain.shown.error ? "Can't show assets while the balance is unavailable." : "Nothing reported."}</li>
      {/each}
    </ul>
  {:else}
    <ul class="list">
      {#each chain.history as entry (entry.txid)}
        {@const kind = kindOf(entry)}
        {@const state = entryState(entry)}
        <li class="row">
          <span class="activity-icon {kind.icon}">
            <ProtoIcon name={kind.icon === "in" ? "receive" : kind.icon === "out" ? "send" : kind.icon} size={16} />
          </span>
          <span class="stack-tight grow">
            <strong>{kind.label}</strong>
            <span class="muted tiny">
              {#if state}<span class="pill tiny-pill" class:warn={state === "Unconfirmed"}>{state}</span>{:else if entry.time}{when(entry.time)}{/if}
              · <code>{shortTxid(entry.txid)}</code>
            </span>
          </span>
          <span class="stack-tight right">
            {#each entry.amounts as a (a.asset)}
              <strong class:in={!a.amount.startsWith("-")}>{a.amount.startsWith("-") ? "" : "+"}{amountIn(a.asset, a.amount)}</strong>
            {/each}
            {#if entry.hidden}<span class="muted tiny">+ hidden amounts</span>{/if}
          </span>
        </li>
      {/each}
    </ul>
    {#if chain.shown.report}
      <p class="reported-inline">Reported by {chain.shown.report.server}. This wallet doesn't verify it.</p>
    {/if}
  {/if}

  {#if receiving}
    <div class="scrim" role="presentation" onclick={() => (receiving = false)}></div>
    <div class="sheet" role="dialog" aria-label="Receive">
      <div class="sheet-head">
        <strong>Receive on {chain.name}</strong>
        <button class="icon" aria-label="Close" onclick={() => (receiving = false)}><ProtoIcon name="close" /></button>
      </div>
      <div class="qr"><ProtoIcon name="qr" size={120} /><span class="tiny muted">QR code (library to vendor)</span></div>
      <code class="address">{chain.address}</code>
      <button class="primary block" onclick={copy}>
        <ProtoIcon name={copied ? "check" : "copy"} />{copied ? "Copied" : "Copy address"}
      </button>
      <p class="muted tiny center">Only for {chain.name} (<span class="mono">{chain.chain}</span>). {shortAddress(chain.address)}</p>
    </div>
  {/if}
</div>

<style>
  .a {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 12px 16px 24px;
    min-height: 100%;
  }
  header {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .spacer {
    flex: 1;
  }
  .switch {
    min-height: 34px;
    padding: 0 10px 0 6px;
    border-radius: 999px;
    gap: 6px;
    font-size: 0.9rem;
  }
  .icon {
    min-height: 34px;
    width: 34px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: none;
    color: var(--muted);
  }
  .chain-avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    border-radius: 50%;
    background: var(--accent);
    color: var(--on-accent);
    font: 700 0.75rem/1 var(--font);
  }
  .chain-avatar.slot {
    background: #7b4fd6;
    color: #fff;
  }
  .menu {
    position: absolute;
    top: 40px;
    right: 0;
    z-index: 5;
    padding: 6px;
    gap: 2px;
    min-width: 160px;
  }
  .menu-row {
    justify-content: flex-start;
    min-height: 36px;
    padding: 0 10px;
    border: none;
    background: none;
    color: var(--text);
    font-weight: 500;
    text-decoration: none;
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 0.9rem;
    border-radius: var(--radius-sm);
  }
  .menu-row:hover {
    background: var(--surface-2);
  }
  .dropdown {
    gap: 4px;
    padding: 10px;
  }
  .chain-row {
    justify-content: flex-start;
    gap: 10px;
    min-height: 52px;
    padding: 0 8px;
    border: 1px solid transparent;
    background: none;
    text-align: left;
    font-weight: 400;
  }
  .chain-row.active {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 8%, transparent);
  }
  .right {
    margin-left: auto;
    text-align: right;
    align-items: flex-end;
  }
  .lock-note {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: -6px;
    color: var(--muted);
    font-size: 0.75rem;
  }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--ok);
  }
  .hero {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 8px 0 0;
    text-align: center;
  }
  .big {
    font-size: 2rem;
    line-height: 1.1;
  }
  .pill {
    padding: 2px 10px;
    border-radius: 999px;
    background: var(--surface-2);
    font-size: 0.8rem;
    font-weight: 600;
  }
  .pill.warn {
    background: var(--warn-bg);
    color: var(--warn);
  }
  .tiny-pill {
    padding: 0 6px;
    font-size: 0.7rem;
  }
  .reported-inline {
    color: var(--muted);
    font-size: 0.75rem;
    font-style: italic;
    text-align: center;
    padding: 4px 8px;
    border: 1px dashed var(--border);
    border-radius: var(--radius-sm);
  }
  .actions {
    display: flex;
    justify-content: center;
    gap: 28px;
  }
  .action {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    min-height: 0;
    padding: 0;
    border: none;
    background: none;
    color: var(--text);
    font-size: 0.8rem;
    font-weight: 600;
    text-decoration: none;
  }
  .action:hover {
    background: none;
  }
  .action.off {
    opacity: 0.45;
    pointer-events: none;
  }
  .circle {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    background: var(--accent);
    color: var(--on-accent);
  }
  .action:hover .circle {
    background: var(--accent-hover);
  }
  .deposits {
    gap: 10px;
    padding: 12px;
  }
  .deposit {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .deposit-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .bar {
    height: 6px;
    border-radius: 3px;
    background: var(--surface-2);
    overflow: hidden;
  }
  .bar span {
    display: block;
    height: 100%;
    background: var(--accent);
  }
  .tabs {
    display: flex;
    border-bottom: 1px solid var(--border);
  }
  .tabs button {
    flex: 1;
    min-height: 40px;
    border: none;
    border-bottom: 2px solid transparent;
    border-radius: 0;
    background: none;
    color: var(--muted);
  }
  .tabs button.on {
    border-bottom-color: var(--accent);
    color: var(--accent);
  }
  .list {
    display: flex;
    flex-direction: column;
    margin-top: -6px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 0;
    border-bottom: 1px solid var(--border);
  }
  .grow {
    flex: 1;
    min-width: 0;
  }
  .empty {
    padding: 16px 0;
    text-align: center;
  }
  .token-avatar,
  .activity-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: var(--accent);
    color: var(--on-accent);
    font-weight: 700;
  }
  .token-avatar.unknown {
    background: var(--surface-2);
    color: var(--muted);
  }
  .activity-icon {
    background: var(--surface-2);
    color: var(--text);
  }
  .activity-icon.in {
    color: var(--ok);
  }
  .activity-icon.deposit {
    color: var(--accent);
  }
  .in {
    color: var(--ok);
  }
  .err {
    color: var(--danger);
  }
  .warn-text {
    color: var(--warn);
  }
  .stack-tight {
    display: flex;
    flex-direction: column;
  }
  .tiny {
    font-size: 0.75rem;
  }
  p.row {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .center {
    text-align: center;
  }
  /* Fixed: in the popup, to the window; in the prototype frame, to the frame. */
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 10;
    background: rgb(0 0 0 / 45%);
  }
  .sheet {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 11;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 16px;
    border-radius: 16px 16px 0 0;
    background: var(--surface);
  }
  .sheet-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .qr {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    align-self: center;
    padding: 14px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: #fff;
    color: #111;
  }
  .address {
    padding: 10px 12px;
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    font-size: 0.75rem;
    user-select: all;
  }
</style>
