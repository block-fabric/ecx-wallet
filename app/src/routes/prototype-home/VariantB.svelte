<script lang="ts">
  // PROTOTYPE, throw away. Variant B, "A, grouped, with MetaMask's tabs": A, but an asset held on
  // several chains is one row (ECX: the total, expanding to each chain's share), and home has
  // Assets / Activity tabs instead of the bottom tab bar, the way MetaMask's home does. Grants
  // moves to the ⋮ menu. The chain chips scope both tabs.
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
  /** Home's scope: every chain, or one. */
  let scope = $state<ProtoChain["id"] | "all">("all");
  let homeTab = $state<"assets" | "activity">("assets");
  let menu = $state(false);
  /** The asset group showing each chain's share. */
  let expanded = $state<string | undefined>(undefined);

  const detail = $derived(chains.find((c) => c.id === open));
  const scopeChain = $derived(chains.find((c) => c.id === scope));
  const scoped = $derived(scopeChain ? [scopeChain] : chains);
  const receiveChain = $derived(chains.find((c) => c.id === receiving));
  const deposits = $derived(chains.flatMap((c) => c.deposits ?? []));
  const feed = $derived(
    scoped
      .flatMap((c) => c.history.map((entry) => ({ chain: c, entry })))
      .sort((x, y) => (y.entry.time ?? Infinity) - (x.entry.time ?? Infinity)),
  );

  /** ECX across the chains in scope: every asset named ECX, from the chains that could be read. */
  const total = $derived.by(() => {
    let sats = 0n;
    let unconfirmed = 0n;
    const missing: string[] = [];
    for (const c of scoped) {
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

  /** The scope's assets, one group per ticker (or per id, for an unnamed asset). */
  const groups = $derived.by(() => {
    const out = new Map<
      string,
      { key: string; name: (typeof ASSET_NAMES)[string] | undefined; rows: { chain: ProtoChain; amount: string }[]; total: bigint; unconfirmed: bigint }
    >();
    for (const c of scoped) {
      for (const a of assetsOf(c.shown)) {
        const name = named(a.asset);
        const key = name?.ticker ?? a.asset;
        const g = out.get(key) ?? { key, name, rows: [], total: 0n, unconfirmed: 0n };
        g.rows.push({ chain: c, amount: a.amount });
        g.total += BigInt(a.amount);
        g.unconfirmed += BigInt(a.unconfirmed ?? "0");
        out.set(key, g);
      }
    }
    return [...out.values()];
  });
  function amountIn(asset: string, amount: string): string {
    const name = named(asset);
    return name ? `${coins(amount, name.decimals)} ${name.ticker}` : grouped(amount);
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
        {#if state}<span class="pill tiny-pill" class:warn={state === "Unconfirmed"}>{state}</span>{:else if entry.time}{when(entry.time)}{/if}
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
              <span class="token-avatar" class:unknown={!name}>{name ? name.ticker[0] : "?"}</span>
              <span class="col grow">
                <strong>{name ? name.ticker : "Unknown asset"}</strong>
                <span class="muted tiny">{#if name}{name.name}{:else}<code title={asset}>{shortAsset(asset)}</code>{/if}</span>
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
        <button class="icon" aria-label="More" onclick={() => (menu = !menu)}><ProtoIcon name="more" /></button>
        {#if menu}
          <div class="menu card">
            <button class="menu-row" onclick={() => ((tab = "grants"), (menu = false))}><ProtoIcon name="grants" /> Grants</button>
            <button class="menu-row"><ProtoIcon name="lock" /> Lock now</button>
          </div>
        {/if}
      </header>
      <p class="lock-note"><span class="dot"></span>Unlocked. Locks itself after 15 minutes without use.</p>

      <div class="filters">
        <button class:on={scope === "all"} onclick={() => (scope = "all")}>All chains</button>
        {#each chains as c (c.id)}
          <button class:on={scope === c.id} onclick={() => (scope = c.id)}>{c.name}</button>
        {/each}
      </div>

      <section class="hero">
        <span class="muted tiny">{scopeChain ? `On ${scopeChain.name}` : "Total across chains"}</span>
        {#if scopeChain && !scopeChain.shown.report}
          <div class="big muted">—</div>
        {:else}
          <div class="big">{coins(total.sats, 8)} ECX</div>
          <div class="muted small">{grouped(total.sats)} sats</div>
        {/if}
        {#if total.unconfirmed !== "0"}<span class="pill warn">+{grouped(total.unconfirmed)} sats unconfirmed</span>{/if}
        {#if scopeChain?.shown.error}
          <p class="error small">{scopeChain.shown.report ? "Couldn't refresh the balance" : "Balance unavailable"}: {scopeChain.shown.error}</p>
        {:else if total.missing.length}
          <span class="pill bad">{total.missing.join(", ")} unavailable, not counted</span>
        {/if}
      </section>

      {@render actions(scopeChain)}

      {#if deposits.length && scope !== "l1"}
        <button class="banner" onclick={() => (open = 24)}>
          <span class="spinner"></span>
          <span class="grow">{deposits.length} Deposit{deposits.length > 1 ? "s" : ""} to Slot 24 in progress</span>
          <ProtoIcon name="forward" size={16} />
        </button>
      {/if}

      <div class="tabs" role="tablist">
        <button role="tab" class:on={homeTab === "assets"} onclick={() => (homeTab = "assets")}>Assets</button>
        <button role="tab" class:on={homeTab === "activity"} onclick={() => (homeTab = "activity")}>Activity</button>
      </div>
      {#if homeTab === "assets"}
        <ul>
          {#each groups as g (g.key)}
            {@const one = g.rows.length === 1}
            <li>
              <button
                class="asset-row"
                onclick={() => (one ? ((open = g.rows[0].chain.id), (chainTab = "assets")) : (expanded = expanded === g.key ? undefined : g.key))}
              >
                <span class="token">
                  <span class="token-avatar" class:unknown={!g.name}>{g.name ? g.name.ticker[0] : "?"}</span>
                  {#if one}
                    <span class="chain-badge" class:slot={g.rows[0].chain.id !== "l1"}>{g.rows[0].chain.id === "l1" ? "e" : g.rows[0].chain.id}</span>
                  {/if}
                </span>
                <span class="col grow">
                  <strong>{g.name ? g.name.ticker : "Unknown asset"}</strong>
                  <span class="muted tiny">
                    {one ? `on ${g.rows[0].chain.name}` : `on ${g.rows.length} chains`}{#if !g.name} · <code title={g.key}>{shortAsset(g.key)}</code>{/if}
                  </span>
                </span>
                <span class="col end">
                  <strong>{g.name ? coins(g.total.toString(), g.name.decimals) : grouped(g.total.toString())}</strong>
                  {#if g.unconfirmed}<span class="tiny warn-text">+{grouped(g.unconfirmed.toString())} sats unconfirmed</span>{/if}
                </span>
                {#if !one}<span class="chev" class:up={expanded === g.key}><ProtoIcon name="chevron" size={16} /></span>{/if}
              </button>
              {#if !one && expanded === g.key}
                <ul class="breakdown">
                  {#each g.rows as r (r.chain.id)}
                    <li>
                      <button class="sub-row" onclick={() => ((open = r.chain.id), (chainTab = "assets"))}>
                        {@render avatar(r.chain, 22)}
                        <span class="grow small">{r.chain.name}{#if r.chain.shown.refreshing} <span class="muted tiny">refreshing…</span>{/if}</span>
                        <span class="small">{g.name ? coins(r.amount, g.name.decimals) : grouped(r.amount)}</span>
                        <ProtoIcon name="forward" size={14} />
                      </button>
                    </li>
                  {/each}
                </ul>
              {/if}
            </li>
          {/each}
          {#each scoped.filter((c) => c.shown.error && !c.shown.report) as c (c.id)}
            <li>
              <button class="asset-row" onclick={() => ((open = c.id), (chainTab = "assets"))}>
                {@render avatar(c)}
                <span class="col grow"><strong>{c.name}</strong><span class="err tiny">Couldn't reach its server</span></span>
                <ProtoIcon name="refresh" size={16} />
              </button>
            </li>
          {/each}
        </ul>
        <p class="reported-inline">Balances are as each chain's server reports them. This wallet doesn't verify them.</p>
      {:else}
        <ul>
          {#each feed as { chain, entry } (entry.txid)}
            {@render activityRow(chain, entry, scope === "all")}
          {/each}
        </ul>
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
        {@const ecx = ecxOf(c)}
        <a class="chain-row pick" class:off={!c.canSend} href="#/send/{c.id}">
          {@render avatar(c, 30)}
          <span class="col grow"><strong>{c.name}</strong><span class="muted tiny">{c.canSend ? (ecx ? `${coins(ecx.amount, 8)} ECX` : "") : c.id === "l1" ? "Sending on eCash isn't built yet" : "Needs a fresh balance"}</span></span>
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
  .filters {
    display: flex;
    gap: 6px;
    margin-top: -4px;
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
  .chev {
    display: flex;
    color: var(--muted);
    transition: transform 0.15s;
  }
  .chev.up {
    transform: rotate(180deg);
  }
  .breakdown {
    margin: 0 0 4px 48px;
    border-bottom: 1px solid var(--border);
  }
  .sub-row {
    width: 100%;
    justify-content: flex-start;
    gap: 10px;
    min-height: 40px;
    padding: 0 4px;
    border: none;
    border-radius: var(--radius-sm);
    background: none;
    font-weight: 400;
    text-align: left;
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
