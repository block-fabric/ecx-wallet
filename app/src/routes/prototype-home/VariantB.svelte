<script lang="ts">
  // PROTOTYPE, throw away. Variant B, "No total, today's units": C, but nothing is added up
  // across chains. Home is one card per chain, each with its own big balance, its Deposits'
  // progress and its server. Units stay as today (sats, hex asset ids): no Chain Entry names
  // needed. Activity is grouped by day.
  import Mark from "$lib/Mark.svelte";
  import type { HistoryEntry } from "$lib/background";
  import { shortAsset } from "$lib/asset";
  import ProtoIcon from "./ProtoIcon.svelte";
  import {
    ASSET_NAMES,
    assetsOf,
    coins,
    depositState,
    grouped,
    kindOf,
    readAt,
    shortTxid,
    when,
    type ProtoChain,
  } from "./fixtures";

  let { chains }: { chains: ProtoChain[] } = $props();

  let tab = $state<"home" | "activity" | "grants">("home");
  /** The chain drilled into, on the Home tab. */
  let open = $state<ProtoChain["id"] | undefined>(undefined);
  let chainTab = $state<"assets" | "activity">("assets");
  /** The Receive sheet, and for which chain. */
  let receiving = $state<ProtoChain["id"] | undefined>(undefined);
  /** The Send sheet's chain picker. */
  let picking = $state(false);
  let copied = $state(false);

  const detail = $derived(chains.find((c) => c.id === open));
  const receiveChain = $derived(chains.find((c) => c.id === receiving));
  const feed = $derived(
    chains
      .flatMap((c) => c.history.map((entry) => ({ chain: c, entry })))
      .sort((x, y) => (y.entry.time ?? Infinity) - (x.entry.time ?? Infinity)),
  );

  /** No asset names: sats for eCash's own coin, the shortened id for anything else. */
  const named = (_asset: string): (typeof ASSET_NAMES)[string] | undefined => undefined;
  const amountIn = (asset: string, amount: string) => `${grouped(amount)} ${asset === "" ? "sats" : shortAsset(asset)}`;
  /** Activity's sections: not yet confirmed, then one per day. */
  const days = $derived.by(() => {
    const out: { day: string; items: typeof feed }[] = [];
    for (const item of feed) {
      const day = item.entry.time === undefined ? "Not yet confirmed" : dayOf(item.entry.time);
      if (out.at(-1)?.day !== day) out.push({ day, items: [] });
      out.at(-1)!.items.push(item);
    }
    return out;
  });
  function dayOf(seconds: number): string {
    const date = new Date(seconds * 1000);
    const today = new Date();
    const yesterday = new Date(Date.now() - 86_400_000);
    if (date.toDateString() === today.toDateString()) return "Today";
    if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
    return date.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
  }

  function copy(address: string) {
    navigator.clipboard.writeText(address).catch(() => {});
    copied = true;
    setTimeout(() => (copied = false), 1500);
  }

  const entryState = (e: HistoryEntry) => (e.confirmed ? undefined : e.trusted ? "Pending" : "Unconfirmed");
</script>

{#snippet avatar(c: ProtoChain, size = 36)}
  <span class="chain-avatar" class:slot={c.id !== "l1"} style:width="{size}px" style:height="{size}px">
    {c.id === "l1" ? "e" : c.id}
  </span>
{/snippet}

{#snippet actions(c: ProtoChain | undefined)}
  <nav class="actions">
    {#if c === undefined || c.id !== "l1"}
      {#if c}
        <a class="action" class:off={!c.canSend} href="#/send/{c.id}"><span class="circle"><ProtoIcon name="send" /></span>Send</a>
      {:else}
        <button class="action" onclick={() => (picking = true)}><span class="circle"><ProtoIcon name="send" /></span>Send</button>
      {/if}
    {/if}
    <button class="action" onclick={() => (receiving = c?.id ?? "l1")}><span class="circle"><ProtoIcon name="receive" /></span>Receive</button>
    <a class="action" href="#/deposit/24"><span class="circle"><ProtoIcon name="deposit" /></span>Deposit</a>
  </nav>
{/snippet}

{#snippet activityRow(c: ProtoChain, entry: HistoryEntry, showChain: boolean)}
  {@const kind = kindOf(entry)}
  {@const state = entryState(entry)}
  <li class="row">
    <span class="activity-icon {kind.icon}">
      <ProtoIcon name={kind.icon === "in" ? "receive" : kind.icon === "out" ? "send" : kind.icon} size={16} />
    </span>
    <span class="col grow">
      <strong class="small">{kind.label}</strong>
      <span class="muted tiny">
        {#if showChain}{c.name} · {/if}
        {#if state}<span class="pill tiny-pill" class:warn={state === "Unconfirmed"}>{state}</span>{:else if entry.time}{new Date(entry.time * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}{/if}
        · <code>{shortTxid(entry.txid)}</code>
      </span>
    </span>
    <span class="col end">
      {#each entry.amounts as a (a.asset)}
        <strong class="small" class:in={!a.amount.startsWith("-")}>{a.amount.startsWith("-") ? "" : "+"}{amountIn(a.asset, a.amount)}</strong>
      {/each}
      {#if entry.hidden}<span class="muted tiny">+ hidden amounts</span>{/if}
    </span>
  </li>
{/snippet}

<div class="c">
  <div class="content">
    {#if tab === "home" && detail}
      <header>
        <button class="icon" aria-label="Back" onclick={() => (open = undefined)}><ProtoIcon name="back" /></button>
        {@render avatar(detail, 26)}
        <span class="title">{detail.name}</span>
        <span class="chip">{detail.chain}</span>
      </header>

      {@const main = assetsOf(detail.shown)[0]}
      <section class="hero">
        {#if main}
          <div class="big">{amountIn(main.asset, main.amount)}</div>
          {#if named(main.asset)}<div class="muted small">{grouped(main.amount)} sats</div>{/if}
          {#if main.unconfirmed}<span class="pill warn">+{grouped(main.unconfirmed)} sats unconfirmed</span>{/if}
        {:else}
          <div class="big muted">—</div>
        {/if}
        {#if detail.shown.error}
          <p class="error small">{detail.shown.report ? "Couldn't refresh the balance" : "Balance unavailable"}: {detail.shown.error}</p>
        {/if}
        {#if detail.shown.report}
          <p class="reported-inline">Reported by {detail.shown.report.server}. This wallet doesn't verify it.</p>
          {#if detail.shown.refreshing}
            <p class="muted tiny line"><span class="spinner"></span>Last read at {readAt(detail.shown.report.readAt)}; refreshing…</p>
          {/if}
        {/if}
      </section>

      {@render actions(detail)}

      {#if detail.deposits?.length}
        <section class="card deposits">
          <h2>Deposits from eCash</h2>
          {#each detail.deposits as d (d.txid)}
            <div class="col">
              <div class="between">
                <strong>{grouped(d.value)} sats</strong>
                {#if d.state === "notFound" || d.state === "unavailable"}<button class="small-button">Stop tracking</button>{/if}
              </div>
              {#if d.state === "confirming"}<div class="bar"><span style:width="{d.confirmations}%"></span></div>{/if}
              <span class="small" class:err={d.state === "notFound"}>{depositState(d)}</span>
            </div>
          {/each}
          <p class="muted tiny">A Deposit takes 100 eCash blocks, then the chain's operator credits it. Withdrawals back take months.</p>
        </section>
      {/if}

      <div class="tabs" role="tablist">
        <button role="tab" class:on={chainTab === "assets"} onclick={() => (chainTab = "assets")}>Assets</button>
        <button role="tab" class:on={chainTab === "activity"} onclick={() => (chainTab = "activity")}>Activity</button>
      </div>
      {#if chainTab === "assets"}
        <ul>
          {#each assetsOf(detail.shown) as { asset, amount, unconfirmed } (asset)}
            {@const name = named(asset)}
            <li class="row">
              <span class="token-avatar" class:unknown={asset !== ""}>{asset === "" ? "s" : "#"}</span>
              <span class="col grow">
                <strong>{asset === "" ? "sats" : "Asset"}</strong>
                <span class="muted tiny">{#if asset === ""}eCash's own coin{:else}<code title={asset}>{shortAsset(asset)}</code>{/if}</span>
              </span>
              <span class="col end">
                <strong>{name ? coins(amount, name.decimals) : grouped(amount)}</strong>
                {#if unconfirmed}<span class="tiny warn-text">+{grouped(unconfirmed)} unconf.</span>{/if}
              </span>
            </li>
          {:else}
            <li class="muted small empty">{detail.shown.error ? "Can't show assets while the balance is unavailable." : "Nothing reported."}</li>
          {/each}
        </ul>
      {:else}
        <ul>
          {#each detail.history as entry (entry.txid)}
            {@render activityRow(detail, entry, false)}
          {/each}
        </ul>
      {/if}
    {:else if tab === "home"}
      <header>
        <Mark size={26} />
        <span class="title">ECX Wallet</span>
        <button class="icon" aria-label="Lock" title="Lock"><ProtoIcon name="lock" /></button>
      </header>
      <p class="lock-note"><span class="dot"></span>Unlocked. Locks itself after 15 minutes without use.</p>

      {@render actions(undefined)}

      {#each chains as c (c.id)}
        <section class="card chain-card">
          <button class="chain-head" onclick={() => ((open = c.id), (chainTab = "assets"))}>
            {@render avatar(c, 30)}
            <span class="col grow"><strong>{c.name}</strong><span class="mono muted tiny">{c.chain}</span></span>
            {#if c.shown.refreshing}<span class="spinner"></span>{/if}
            <ProtoIcon name="forward" size={16} />
          </button>
          {#if c.shown.error}
            <p class="error small">{c.shown.report ? "Couldn't refresh the balance" : "Balance unavailable"}: {c.shown.error}</p>
          {/if}
          {#each assetsOf(c.shown) as { asset, amount, unconfirmed }, i (asset)}
            <div class="balance-line" class:first={i === 0}>
              <span class="num">{grouped(amount)}</span>
              {#if asset === ""}<span class="muted">sats</span>{:else}<span class="muted small">asset <code title={asset}>{shortAsset(asset)}</code></span>{/if}
            </div>
            {#if unconfirmed}<span class="pill warn start">+{grouped(unconfirmed)}{asset === "" ? " sats" : ""} unconfirmed</span>{/if}
          {/each}
          {#each c.deposits ?? [] as d (d.txid)}
            <div class="col mini-deposit">
              <div class="between">
                <span class="small"><strong>Deposit</strong> of {grouped(d.value)} sats</span>
                {#if d.state === "confirming"}<span class="tiny muted">{d.confirmations} / 100</span>{/if}
              </div>
              {#if d.state === "confirming"}
                <div class="bar"><span style:width="{d.confirmations}%"></span></div>
              {:else}
                <span class="tiny" class:err={d.state === "notFound"}>{depositState(d)}</span>
              {/if}
            </div>
          {/each}
          {#if c.shown.report}
            <p class="reported-inline">Reported by {c.shown.report.server}. This wallet doesn't verify it.</p>
          {/if}
        </section>
      {/each}
    {:else if tab === "activity"}
      <header><span class="title">Activity</span></header>
      {#each days as { day, items } (day)}
        <section class="col">
          <h2>{day}</h2>
          <ul>
            {#each items as { chain, entry } (entry.txid)}
              {@render activityRow(chain, entry, true)}
            {/each}
          </ul>
        </section>
      {/each}
      <p class="reported-inline">Reported by each chain's server. This wallet doesn't verify it.</p>
    {:else}
      <header><span class="title">Grants</span></header>
      <p class="muted small">(The real Grants screen would go here.)</p>
    {/if}
  </div>

  <nav class="tabbar">
    <button class:on={tab === "home"} onclick={() => ((tab = "home"), (open = undefined))}><ProtoIcon name="wallet" />Home</button>
    <button class:on={tab === "activity"} onclick={() => (tab = "activity")}><ProtoIcon name="activity" />Activity</button>
    <button class:on={tab === "grants"} onclick={() => (tab = "grants")}><ProtoIcon name="grants" />Grants</button>
  </nav>

  {#if receiveChain || picking}
    <div class="scrim" role="presentation" onclick={() => ((receiving = undefined), (picking = false))}></div>
  {/if}
  {#if receiveChain}
    <div class="sheet" role="dialog" aria-label="Receive">
      <div class="between">
        <strong>Receive</strong>
        <button class="icon" aria-label="Close" onclick={() => (receiving = undefined)}><ProtoIcon name="close" /></button>
      </div>
      <div class="segmented">
        {#each chains as c (c.id)}
          <button class:on={c.id === receiveChain.id} onclick={() => (receiving = c.id)}>{c.name}</button>
        {/each}
      </div>
      <div class="qr"><ProtoIcon name="qr" size={110} /><span class="tiny">QR code (library to vendor)</span></div>
      <code class="address">{receiveChain.address}</code>
      <button class="primary block" onclick={() => copy(receiveChain.address)}>
        <ProtoIcon name={copied ? "check" : "copy"} />{copied ? "Copied" : "Copy address"}
      </button>
      <p class="muted tiny center">Only for {receiveChain.name} (<span class="mono">{receiveChain.chain}</span>).</p>
    </div>
  {:else if picking}
    <div class="sheet" role="dialog" aria-label="Send from">
      <div class="between">
        <strong>Send from</strong>
        <button class="icon" aria-label="Close" onclick={() => (picking = false)}><ProtoIcon name="close" /></button>
      </div>
      {#each chains as c (c.id)}
        {@const first = assetsOf(c.shown)[0]}
        <a class="chain-row pick" class:off={!c.canSend} href="#/send/{c.id}">
          {@render avatar(c, 30)}
          <span class="col grow"><strong>{c.name}</strong><span class="muted tiny">{c.canSend ? (first ? amountIn(first.asset, first.amount) : "") : c.id === "l1" ? "Sending on eCash isn't built yet" : "Needs a fresh balance"}</span></span>
          <ProtoIcon name="forward" size={16} />
        </a>
      {/each}
    </div>
  {/if}
</div>

<style>
  .c {
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
    gap: 8px;
    min-height: 36px;
  }
  .title {
    flex: 1;
    font-weight: 700;
    font-size: 1.05rem;
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
    font: 700 0.8rem/1 var(--font);
  }
  .chain-avatar.slot {
    background: #7b4fd6;
    color: #fff;
  }
  .lock-note {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: -8px;
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
    text-align: center;
  }
  .big {
    font-size: 2rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
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
  .pill.bad {
    background: var(--danger-bg);
    color: var(--danger);
  }
  .tiny-pill {
    padding: 0 6px;
    font-size: 0.7rem;
  }
  .reported-inline {
    padding: 4px 8px;
    border: 1px dashed var(--border);
    border-radius: var(--radius-sm);
    color: var(--muted);
    font-size: 0.75rem;
    font-style: italic;
    text-align: center;
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
  .off {
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
  .banner {
    justify-content: flex-start;
    gap: 10px;
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 8%, var(--surface));
    font-size: 0.85rem;
    text-align: left;
  }
  .chains {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    box-shadow: var(--shadow);
  }
  .chains li + li {
    border-top: 1px solid var(--border);
  }
  .chain-row {
    display: flex;
    align-items: center;
    width: 100%;
    justify-content: flex-start;
    gap: 12px;
    min-height: 62px;
    padding: 8px 12px;
    border: none;
    border-radius: 0;
    background: none;
    color: var(--text);
    font-weight: 400;
    text-align: left;
    text-decoration: none;
  }
  .chain-card {
    gap: 8px;
    padding: 12px 14px;
  }
  .chain-head {
    justify-content: flex-start;
    gap: 10px;
    min-height: 0;
    margin: -4px -6px 2px;
    padding: 4px 6px;
    border: none;
    background: none;
    font-weight: 400;
    text-align: left;
  }
  .balance-line {
    display: flex;
    align-items: baseline;
    gap: 6px;
  }
  .num {
    font-size: 1.05rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }
  .balance-line.first .num {
    font-size: 1.7rem;
    line-height: 1.15;
  }
  .start {
    align-self: flex-start;
  }
  .mini-deposit {
    padding-top: 8px;
    border-top: 1px solid var(--border);
  }
  .chain-row.pick {
    border-radius: var(--radius-sm);
  }
  .chain-row:hover {
    background: var(--surface-2);
  }
  .deposits {
    gap: 10px;
    padding: 12px;
  }
  .bar {
    height: 6px;
    margin: 2px 0;
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
  .tabs + ul {
    margin-top: -14px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 0;
    border-bottom: 1px solid var(--border);
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
  .token-avatar.unknown,
  .activity-icon {
    background: var(--surface-2);
    color: var(--muted);
  }
  .activity-icon {
    color: var(--text);
  }
  .activity-icon.in,
  .in {
    color: var(--ok);
  }
  .activity-icon.deposit {
    color: var(--accent);
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
  .between {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
  }
  .line {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .err {
    color: var(--danger);
  }
  .warn-text {
    color: var(--warn);
  }
  .tiny {
    font-size: 0.75rem;
  }
  .center {
    text-align: center;
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
    padding: 12px;
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
  /* Fixed: in the popup, to the window; in the prototype frame, to the frame. */
  .tabbar {
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
</style>
