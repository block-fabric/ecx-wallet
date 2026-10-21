<script lang="ts">
  // PROTOTYPE, throw away. Variant C, "Chain cards and one feed": each chain is a swipeable card
  // (balance, address, copy), action pills follow the card in view, Deposits sit in an "In
  // progress" strip with progress bars, and one activity feed below, filterable by chain.
  import Mark from "$lib/Mark.svelte";
  import type { HistoryEntry } from "$lib/background";
  import { shortAsset } from "$lib/asset";
  import ProtoIcon from "./ProtoIcon.svelte";
  import { ASSET_NAMES, assetsOf, coins, depositState, grouped, kindOf, readAt, shortAddress, when, type ProtoChain } from "./fixtures";

  let { chains }: { chains: ProtoChain[] } = $props();

  let current = $state(0);
  let filter = $state<ProtoChain["id"] | "all">("all");
  let copied = $state<ProtoChain["id"] | undefined>(undefined);
  let track: HTMLDivElement;

  const chain = $derived(chains[current]);
  const deposits = $derived(chains.flatMap((c) => c.deposits ?? []));
  const feed = $derived(
    chains
      .filter((c) => filter === "all" || c.id === filter)
      .flatMap((c) => c.history.map((entry) => ({ chain: c, entry })))
      .sort((x, y) => (y.entry.time ?? Infinity) - (x.entry.time ?? Infinity)),
  );

  function onscroll() {
    current = Math.round(track.scrollLeft / track.clientWidth);
  }
  function go(i: number) {
    track.scrollTo({ left: i * track.clientWidth, behavior: "smooth" });
  }
  function copy(c: ProtoChain) {
    navigator.clipboard.writeText(c.address).catch(() => {});
    copied = c.id;
    setTimeout(() => (copied = undefined), 1500);
  }

  function amountIn(asset: string, amount: string): string {
    const name = ASSET_NAMES[asset];
    return name ? `${coins(amount, name.decimals)} ${name.ticker}` : `${grouped(amount)} × ${shortAsset(asset)}`;
  }

  const entryState = (e: HistoryEntry) => (e.confirmed ? undefined : e.trusted ? "Pending" : "Unconfirmed");
</script>

<div class="c">
  <header>
    <Mark size={26} />
    <span class="title">ECX Wallet</span>
    <a class="icon" href="#/grants" aria-label="Grants" title="Grants"><ProtoIcon name="grants" /></a>
    <button class="icon" aria-label="Lock" title="Lock"><ProtoIcon name="lock" /></button>
  </header>

  <div class="track" bind:this={track} {onscroll}>
    {#each chains as c (c.id)}
      {@const assets = assetsOf(c.shown)}
      <article class="wallet-card" class:slot={c.id !== "l1"} class:broken={c.shown.error && !c.shown.report}>
        <div class="card-top">
          <strong>{c.name}</strong>
          <span class="card-chip">{c.chain}</span>
        </div>
        {#if assets[0]}
          <div class="card-balance">{amountIn(assets[0].asset, assets[0].amount)}</div>
          <div class="card-sub">
            {grouped(assets[0].amount)} sats
            {#if assets[0].unconfirmed}· <span class="card-warn">+{grouped(assets[0].unconfirmed)} unconfirmed</span>{/if}
            {#if assets.length > 1}· +{assets.length - 1} asset{/if}
          </div>
        {:else if c.shown.error}
          <div class="card-balance">—</div>
          <div class="card-sub">Couldn't reach the server. <button class="card-link"><ProtoIcon name="refresh" size={12} />Retry</button></div>
        {/if}
        <button class="card-address" onclick={() => copy(c)} title="Copy address">
          <code>{shortAddress(c.address)}</code>
          <ProtoIcon name={copied === c.id ? "check" : "copy"} size={14} />
        </button>
        {#if c.shown.report}
          <p class="card-reported">
            Reported by {c.shown.report.server}. This wallet doesn't verify it.
            {#if c.shown.refreshing}<br />Last read at {readAt(c.shown.report.readAt)}; refreshing…{/if}
          </p>
        {/if}
      </article>
    {/each}
  </div>
  <div class="dots">
    {#each chains as c, i (c.id)}
      <button class="dot" class:on={i === current} aria-label="Show {c.name}" onclick={() => go(i)}></button>
    {/each}
  </div>

  {#if chain.shown.error}
    <p class="error small">{chain.shown.report ? "Couldn't refresh the balance" : "Balance unavailable"}: {chain.shown.error}</p>
  {/if}

  <nav class="pills">
    {#if chain.id !== "l1"}
      <a class="button pill-button" class:off={!chain.canSend} href="#/send/{chain.id}"><ProtoIcon name="send" size={16} />Send</a>
    {/if}
    <button class="pill-button" onclick={() => copy(chain)}><ProtoIcon name="qr" size={16} />Receive</button>
    <a class="button pill-button" href="#/deposit/24"><ProtoIcon name="deposit" size={16} />{chain.id === "l1" ? "To Slot 24" : "Deposit"}</a>
  </nav>

  <p class="muted tiny lock-note">Unlocked. Locks itself after 15 minutes without use.</p>

  {#if deposits.length}
    <section class="section">
      <h2>In progress</h2>
      {#each deposits as d (d.txid)}
        {@const pct = d.state === "confirming" ? d.confirmations : d.state === "notFound" || d.state === "unavailable" ? 0 : 100}
        <div class="progress-item">
          <span class="activity-icon deposit"><ProtoIcon name="deposit" size={16} /></span>
          <div class="grow col">
            <div class="between">
              <strong class="small">Deposit to Slot {d.slot}</strong>
              <strong class="small">{grouped(d.value)} sats</strong>
            </div>
            <div class="bar" class:stuck={pct === 0}><span style:width="{Math.max(pct, 4)}%"></span></div>
            <span class="tiny" class:err={d.state === "notFound"}>{depositState(d)}</span>
          </div>
        </div>
      {/each}
      <p class="muted tiny">Deposits wait 100 eCash blocks, then the chain's operator credits them. Withdrawals back to eCash take months.</p>
    </section>
  {/if}

  <section class="section">
    <div class="between">
      <h2>Activity</h2>
    </div>
    <div class="filters">
      <button class:on={filter === "all"} onclick={() => (filter = "all")}>All</button>
      {#each chains as c (c.id)}
        <button class:on={filter === c.id} onclick={() => (filter = c.id)}>{c.name}</button>
      {/each}
    </div>
    <ul>
      {#each feed as { chain: c, entry } (entry.txid)}
        {@const kind = kindOf(entry)}
        {@const state = entryState(entry)}
        <li class="feed-row">
          <span class="activity-icon {kind.icon}">
            <ProtoIcon name={kind.icon === "in" ? "receive" : kind.icon === "out" ? "send" : kind.icon} size={16} />
          </span>
          <span class="grow col">
            <strong class="small">{kind.label}</strong>
            <span class="muted tiny">{c.name} · {#if state}<span class:warn-text={state === "Unconfirmed"}>{state}</span>{:else if entry.time}{when(entry.time)}{/if}</span>
          </span>
          <span class="col end">
            {#each entry.amounts as a (a.asset)}
              <strong class="small" class:in={!a.amount.startsWith("-")}>{a.amount.startsWith("-") ? "" : "+"}{amountIn(a.asset, a.amount)}</strong>
            {/each}
            {#if entry.hidden}<span class="muted tiny">+ hidden</span>{/if}
          </span>
        </li>
      {/each}
    </ul>
  </section>
</div>

<style>
  .c {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 12px 0 24px;
  }
  .c > :not(.track) {
    margin: 0 16px;
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .title {
    flex: 1;
    font-weight: 700;
  }
  .icon {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 34px;
    width: 34px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: none;
    color: var(--muted);
  }
  .icon:hover {
    background: var(--surface-2);
  }
  .track {
    display: flex;
    overflow-x: auto;
    scroll-snap-type: x mandatory;
    scrollbar-width: none;
  }
  .wallet-card {
    flex: 0 0 calc(100% - 32px);
    margin: 0 16px;
    scroll-snap-align: center;
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-height: 186px;
    padding: 16px;
    border-radius: 18px;
    background: linear-gradient(135deg, #2a62e0, #1b3f9a);
    color: #fff;
  }
  .wallet-card.slot {
    background: linear-gradient(135deg, #7b4fd6, #4a2a94);
  }
  .wallet-card.broken {
    background: linear-gradient(135deg, #6b7280, #3f4553);
  }
  .card-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .card-chip {
    padding: 1px 8px;
    border-radius: 999px;
    background: rgb(255 255 255 / 18%);
    font-family: var(--mono);
    font-size: 0.7rem;
  }
  .card-balance {
    margin-top: 6px;
    font-size: 1.7rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    line-height: 1.1;
  }
  .card-sub {
    font-size: 0.8rem;
    opacity: 0.85;
  }
  .card-warn {
    color: #ffd58a;
    font-weight: 600;
  }
  .card-link {
    min-height: 0;
    padding: 0 6px;
    border: none;
    background: rgb(255 255 255 / 18%);
    color: #fff;
    font-size: 0.75rem;
    gap: 4px;
  }
  .card-address {
    align-self: flex-start;
    gap: 6px;
    min-height: 26px;
    margin-top: auto;
    padding: 0 8px;
    border: none;
    border-radius: 6px;
    background: rgb(255 255 255 / 14%);
    color: #fff;
    font-weight: 400;
  }
  .card-address:hover {
    background: rgb(255 255 255 / 24%);
  }
  .card-reported {
    font-size: 0.68rem;
    font-style: italic;
    opacity: 0.8;
  }
  .dots {
    display: flex;
    justify-content: center;
    gap: 6px;
    margin-top: -6px !important;
  }
  .dot {
    width: 7px;
    height: 7px;
    min-height: 0;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: var(--border);
  }
  .dot.on {
    width: 18px;
    border-radius: 4px;
    background: var(--accent);
  }
  .pills {
    display: flex;
    gap: 8px;
  }
  .pill-button {
    flex: 1;
    min-height: 38px;
    padding: 0 10px;
    gap: 6px;
    border-radius: 999px;
    font-size: 0.85rem;
  }
  .pill-button.off {
    opacity: 0.45;
    pointer-events: none;
  }
  .lock-note {
    margin-top: -6px !important;
    text-align: center;
  }
  .section {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .progress-item,
  .feed-row {
    display: flex;
    align-items: flex-start;
    gap: 12px;
  }
  .feed-row {
    align-items: center;
    padding: 8px 0;
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
  .bar {
    height: 6px;
    margin: 4px 0 2px;
    border-radius: 3px;
    background: var(--surface-2);
    overflow: hidden;
  }
  .bar span {
    display: block;
    height: 100%;
    background: var(--accent);
  }
  .bar.stuck span {
    background: var(--danger);
  }
  .filters {
    display: flex;
    gap: 6px;
  }
  .filters button {
    min-height: 28px;
    padding: 0 12px;
    border-radius: 999px;
    font-size: 0.8rem;
  }
  .filters button.on {
    border-color: var(--text);
    background: var(--text);
    color: var(--bg);
  }
  .col {
    display: flex;
    flex-direction: column;
  }
  .end {
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
    align-items: baseline;
    gap: 8px;
  }
  .err {
    color: var(--danger);
  }
  .warn-text {
    color: var(--warn);
    font-weight: 600;
  }
  .tiny {
    font-size: 0.75rem;
  }
</style>
