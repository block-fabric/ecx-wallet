<script lang="ts">
  // PROTOTYPE, throw away. Variant C, "B, folded": B, but each chain's section in Assets shows the
  // chain's ECX subtotal and folds away, pending Deposits head Activity as "In progress" (no banner
  // above the tabs; the Activity tab counts them), and Activity is grouped by day.
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
    shortAddress,
    shortTxid,
    when,
    type ProtoChain,
  } from "./fixtures";

  let { chains }: { chains: ProtoChain[] } = $props();

  let tab = $state<"home" | "activity" | "grants">("home");
  /** The chain drilled into, on the Home tab. */
  let open = $state<ProtoChain["id"] | undefined>(undefined);
  let chainTab = $state<"assets" | "activity">("assets");
  /** The Receive sheet, and whose QR code it shows, if any. */
  let receiving = $state<{ qr?: ProtoChain["id"] } | undefined>(undefined);
  /** The address just copied, to tick its button. */
  let copiedAddress = $state<string | undefined>(undefined);
  /** The Send sheet's chain picker. */
  let picking = $state(false);
  let copied = $state(false);
  let homeTab = $state<"assets" | "activity">("assets");
  let menu = $state(false);
  /** Chains whose section in Assets is folded away. */
  let folded = $state<Record<string, boolean>>({});

  const detail = $derived(chains.find((c) => c.id === open));
  const deposits = $derived(chains.flatMap((c) => c.deposits ?? []));
  const feed = $derived(
    chains
      .flatMap((c) => c.history.map((entry) => ({ chain: c, entry })))
      .sort((x, y) => (y.entry.time ?? Infinity) - (x.entry.time ?? Infinity)),
  );

  /** ECX across chains: every asset named ECX, from the chains that could be read. */
  const total = $derived.by(() => {
    let sats = 0n;
    let unconfirmed = 0n;
    const missing: string[] = [];
    for (const c of chains) {
      if (c.shown.report === undefined) missing.push(c.name);
      for (const a of assetsOf(c.shown)) {
        if (ASSET_NAMES[a.asset]?.ticker !== "ECX") continue;
        sats += BigInt(a.amount);
        if (a.unconfirmed) unconfirmed += BigInt(a.unconfirmed);
      }
    }
    return { sats: sats.toString(), unconfirmed: unconfirmed.toString(), missing };
  });

  const named = (asset: string) => ASSET_NAMES[asset];
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
    if (date.toDateString() === new Date().toDateString()) return "Today";
    if (date.toDateString() === new Date(Date.now() - 86_400_000).toDateString()) return "Yesterday";
    return date.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
  }
  const timeOf = (seconds: number) => new Date(seconds * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  /** An ECX amount in base units, in ECX. */
  const ecxAmount = (sats: string) => `${coins(sats, 8)} ECX`;
  function amountIn(asset: string, amount: string): string {
    const name = named(asset);
    return name ? ecxAmount(amount) : grouped(amount);
  }
  /** A chain's ECX, for its row. */
  const ecxOf = (c: ProtoChain) => assetsOf(c.shown).find((a) => named(a.asset)?.ticker === "ECX");

  function copy(address: string) {
    navigator.clipboard.writeText(address).catch(() => {});
    copied = true;
    setTimeout(() => (copied = false), 1500);
  }

  const entryState = (e: HistoryEntry) => (e.confirmed ? undefined : e.trusted ? "Pending" : "Unconfirmed");
</script>

{#snippet avatar(c: ProtoChain, size = 36)}
  <span class="chain-avatar" class:slot={c.id !== "l1"} style:width="{size}px" style:height="{size}px">
    {c.id === "l1" ? "e" : "E+"}
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
    <button class="action" onclick={() => (receiving = { qr: c?.id })}><span class="circle"><ProtoIcon name="receive" /></span>Receive</button>
    <a class="action" href="#/deposit/24"><span class="circle"><ProtoIcon name="deposit" /></span>Deposit</a>
  </nav>
{/snippet}

{#snippet activityRow(c: ProtoChain, entry: HistoryEntry, showChain: boolean, byDay: boolean)}
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
        {#if state}<span class="pill tiny-pill" class:warn={state === "Unconfirmed"}>{state}</span>{:else if entry.time}{byDay ? timeOf(entry.time) : when(entry.time)}{/if}
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
          {#if main.unconfirmed}<span class="pill warn">+{amountIn(main.asset, main.unconfirmed)} unconfirmed</span>{/if}
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
                <strong>{ecxAmount(d.value)}</strong>
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
              <span class="token-avatar" class:unknown={!name}>{name ? name.ticker[0] : "?"}</span>
              <span class="col grow">
                <strong>{name ? name.ticker : "Unknown asset"}</strong>
                <span class="muted tiny">{#if name}{name.name}{:else}<code title={asset}>{shortAsset(asset)}</code>{/if}</span>
              </span>
              <span class="col end">
                <strong>{name ? coins(amount, name.decimals) : grouped(amount)}</strong>
                {#if unconfirmed}<span class="tiny warn-text">+{amountIn(asset, unconfirmed)} unconfirmed</span>{/if}
              </span>
            </li>
          {:else}
            <li class="muted small empty">{detail.shown.error ? "Can't show assets while the balance is unavailable." : "Nothing reported."}</li>
          {/each}
        </ul>
      {:else}
        <ul>
          {#each detail.history as entry (entry.txid)}
            {@render activityRow(detail, entry, false, false)}
          {/each}
        </ul>
      {/if}
    {:else if tab === "home"}
      <header>
        <Mark size={26} />
        <span class="title">ECX Wallet</span>
        <button class="icon" aria-label="Lock" title="Lock"><ProtoIcon name="lock" /></button>
        <button class="icon" aria-label="More" onclick={() => (menu = !menu)}><ProtoIcon name="more" /></button>
        {#if menu}
          <div class="menu card">
            <button class="menu-row" onclick={() => ((tab = "grants"), (menu = false))}><ProtoIcon name="grants" /> Grants</button>
            <button class="menu-row"><ProtoIcon name="lock" /> Lock now</button>
          </div>
        {/if}
      </header>
      <p class="lock-note"><span class="dot"></span>Unlocked. Locks itself after 15 minutes without use.</p>

      <section class="hero">
        <span class="muted tiny">Total across chains</span>
        <div class="big">{ecxAmount(total.sats)}</div>
        {#if total.unconfirmed !== "0"}<span class="pill warn">+{ecxAmount(total.unconfirmed)} unconfirmed</span>{/if}
        {#if total.missing.length}
          <span class="pill bad">{total.missing.join(", ")} unavailable, not counted</span>
        {/if}
      </section>

      {@render actions(undefined)}

      <div class="tabs" role="tablist">
        <button role="tab" class:on={homeTab === "assets"} onclick={() => (homeTab = "assets")}>Assets</button>
        <button role="tab" class:on={homeTab === "activity"} onclick={() => (homeTab = "activity")}>
          Activity{#if deposits.length}<span class="count" title="Deposits in progress">{deposits.length}</span>{/if}
        </button>
      </div>
      {#if homeTab === "assets"}
        {#each chains as c (c.id)}
          {@const assets = assetsOf(c.shown)}
          {@const ecx = ecxOf(c)}
          <section class="chain-group">
            <div class="chain-heading">
              <button class="chain-name" onclick={() => ((open = c.id), (chainTab = "assets"))}>
                {@render avatar(c, 24)}
                <span class="col">
                  <strong>{c.name}</strong>
                  <span class="mono muted tiny">{c.chain}</span>
                </span>
              </button>
              <span class="grow"></span>
              {#if c.shown.refreshing}<span class="spinner"></span>{/if}
              {#if ecx}<span class="small subtotal">{ecxAmount(ecx.amount)}</span>{/if}
              <button
                class="fold"
                class:up={!folded[c.id]}
                aria-label={folded[c.id] ? `Show ${c.name}` : `Hide ${c.name}`}
                aria-expanded={!folded[c.id]}
                onclick={() => (folded[c.id] = !folded[c.id])}
              >
                <ProtoIcon name="chevron" size={16} />
              </button>
            </div>
            {#if c.shown.error && !c.shown.report}
              <p class="err small unreachable">Couldn't reach its server. <button class="link"><ProtoIcon name="refresh" size={12} /> Retry</button></p>
            {/if}
            {#if !folded[c.id]}
            <ul>
              {#each assets as { asset, amount, unconfirmed } (asset)}
                {@const name = named(asset)}
                <li>
                  <button class="asset-row" onclick={() => ((open = c.id), (chainTab = "assets"))}>
                    <span class="token-avatar" class:unknown={!name}>{name ? name.ticker[0] : "?"}</span>
                    <span class="col grow">
                      <strong>{name ? name.ticker : "Unknown asset"}</strong>
                      <span class="muted tiny">{#if name}{name.name}{:else}<code title={asset}>{shortAsset(asset)}</code>{/if}</span>
                    </span>
                    <span class="col end">
                      <strong>{name ? coins(amount, name.decimals) : grouped(amount)}</strong>
                      {#if unconfirmed}<span class="tiny warn-text">+{amountIn(asset, unconfirmed)} unconfirmed</span>{/if}
                    </span>
                  </button>
                </li>
              {/each}
            </ul>
            {/if}
          </section>
        {/each}
        <p class="reported-inline">Balances are as each chain's server reports them. This wallet doesn't verify them.</p>
      {:else}
        {#if deposits.length}
          <section class="col day">
            <h2>In progress</h2>
            <ul>
              {#each deposits as d (d.txid)}
                <li class="row">
                  <span class="activity-icon deposit"><ProtoIcon name="deposit" size={16} /></span>
                  <div class="col grow">
                    <div class="between">
                      <strong class="small">Deposit to {d.chainName}</strong>
                      <strong class="small">{ecxAmount(d.value)}</strong>
                    </div>
                    {#if d.state === "confirming"}
                      <div class="bar"><span style:width="{d.confirmations}%"></span></div>
                    {/if}
                    <span class="tiny" class:muted={d.state !== "notFound"} class:err={d.state === "notFound"}>{depositState(d)}</span>
                    {#if d.state === "notFound" || d.state === "unavailable"}
                      <button class="small-button stop">Stop tracking</button>
                    {/if}
                  </div>
                </li>
              {/each}
            </ul>
            <p class="muted tiny">Deposits wait 100 eCash blocks, then the chain's operator credits them. Withdrawals take months.</p>
          </section>
        {/if}
        {#each days as { day, items } (day)}
          <section class="col day">
            <h2>{day}</h2>
            <ul>
              {#each items as { chain, entry } (entry.txid)}
                {@render activityRow(chain, entry, true, true)}
              {/each}
            </ul>
          </section>
        {/each}
        <p class="reported-inline">Reported by each chain's server. This wallet doesn't verify it.</p>
      {/if}
    {:else}
      <header>
        <button class="icon" aria-label="Back" onclick={() => (tab = "home")}><ProtoIcon name="back" /></button>
        <span class="title">Grants</span>
      </header>
      <p class="muted small">(The real Grants screen would go here.)</p>
    {/if}
  </div>

  {#if receiving || picking}
    <div class="scrim" role="presentation" onclick={() => ((receiving = undefined), (picking = false))}></div>
  {/if}
  {#if receiving}
    <div class="sheet" role="dialog" aria-label="Receive">
      <div class="between">
        <strong>Receive</strong>
        <button class="icon" aria-label="Close" onclick={() => (receiving = undefined)}><ProtoIcon name="close" /></button>
      </div>
      <p class="muted tiny">Each chain has its own address. Only send a chain's assets to its own address.</p>
      <ul class="addresses">
        {#each chains as c (c.id)}
          {@const showing = receiving.qr === c.id}
          <li class="address-row" class:showing>
            <div class="between">
              {@render avatar(c, 28)}
              <span class="col grow">
                <strong class="small">{c.name}</strong>
                <code class="tiny muted">{shortAddress(c.address)}</code>
              </span>
              <button class="icon small-icon" aria-label="Show QR code for {c.name}" class:on={showing} onclick={() => (receiving = { qr: showing ? undefined : c.id })}>
                <ProtoIcon name="qr" size={16} />
              </button>
              <button
                class="icon small-icon"
                aria-label="Copy {c.name} address"
                onclick={() => {
                  copy(c.address);
                  copiedAddress = c.address;
                }}
              >
                <ProtoIcon name={copied && copiedAddress === c.address ? "check" : "copy"} size={16} />
              </button>
            </div>
            {#if showing}
              <div class="qr"><ProtoIcon name="qr" size={96} /><span class="tiny">QR code (library to vendor)</span></div>
              <code class="address">{c.address}</code>
              <p class="muted tiny center">Only for {c.name} (<span class="mono">{c.chain}</span>).</p>
            {/if}
          </li>
        {/each}
      </ul>
    </div>
  {:else if picking}
    <div class="sheet" role="dialog" aria-label="Send from">
      <div class="between">
        <strong>Send from</strong>
        <button class="icon" aria-label="Close" onclick={() => (picking = false)}><ProtoIcon name="close" /></button>
      </div>
      {#each chains as c (c.id)}
        {@const ecx = ecxOf(c)}
        <a class="chain-row pick" class:off={!c.canSend} href="#/send/{c.id}">
          {@render avatar(c, 30)}
          <span class="col grow"><strong>{c.name}</strong><span class="muted tiny">{c.canSend ? (ecx ? ecxAmount(ecx.amount) : "") : c.id === "l1" ? "Sending on eCash isn't built yet" : "Needs a fresh balance"}</span></span>
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
    padding: 12px 16px 24px;
  }
  header {
    position: relative;
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
  .token {
    position: relative;
    flex: none;
  }
  .chain-badge {
    position: absolute;
    right: -4px;
    bottom: -4px;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border: 2px solid var(--surface);
    border-radius: 50%;
    background: var(--accent);
    color: var(--on-accent);
    font: 700 0.55rem/1 var(--font);
  }
  .chain-badge.slot {
    background: #7b4fd6;
    color: #fff;
  }
  .menu {
    position: absolute;
    top: 40px;
    right: 0;
    z-index: 5;
    gap: 2px;
    min-width: 160px;
    padding: 6px;
  }
  .menu-row {
    justify-content: flex-start;
    gap: 10px;
    min-height: 36px;
    padding: 0 10px;
    border: none;
    background: none;
    font-size: 0.9rem;
    font-weight: 500;
  }
  .asset-row {
    width: 100%;
    justify-content: flex-start;
    gap: 12px;
    min-height: 60px;
    padding: 8px 0;
    border: none;
    border-bottom: 1px solid var(--border);
    border-radius: 0;
    background: none;
    font-weight: 400;
    text-align: left;
  }
  .asset-row:hover {
    background: none;
  }
  .chain-group {
    display: flex;
    flex-direction: column;
    margin-top: -6px;
  }
  .chain-heading {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 48px;
  }
  .chain-name {
    justify-content: flex-start;
    gap: 8px;
    min-height: 0;
    padding: 0;
    border: none;
    background: none;
    text-align: left;
  }
  .chain-name:hover {
    background: none;
    color: var(--accent);
  }
  .subtotal {
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .fold {
    width: 28px;
    min-height: 28px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: none;
    color: var(--muted);
    transition: transform 0.15s;
  }
  .fold.up {
    transform: rotate(180deg);
  }
  .addresses {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .address-row {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .address-row .between {
    gap: 10px;
  }
  .address-row.showing {
    border-color: var(--accent);
  }
  .icon.on {
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    color: var(--accent);
  }
  .small-icon {
    width: 24px;
    min-height: 24px;
    flex: none;
  }
  .count {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    height: 18px;
    margin-left: 6px;
    padding: 0 5px;
    border-radius: 999px;
    background: var(--accent);
    color: var(--on-accent);
    font-size: 0.7rem;
  }
  .stop {
    align-self: flex-start;
    margin-top: 4px;
  }
  .day {
    margin-top: 4px;
  }
  .day h2 {
    padding-top: 6px;
  }
  .chain-group .asset-row {
    padding-left: 12px;
  }
  .chain-group .token-avatar {
    width: 30px;
    height: 30px;
    font-size: 0.85rem;
  }
  .unreachable {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 0 10px 12px;
    border-bottom: 1px solid var(--border);
  }
  .link {
    min-height: 0;
    padding: 0;
    gap: 4px;
    border: none;
    background: none;
    color: var(--accent);
    font-size: 0.8rem;
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
