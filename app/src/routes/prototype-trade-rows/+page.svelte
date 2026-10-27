<script lang="ts">
  // PROTOTYPE, throw away (#60, item 2, Q1): how Activity could show a Flush trade with its payout.
  // Three variants of the same fixture rows, switched by ?variant=A|B|C (← → keys or the bar):
  //   A: B with the pair top to bottom beside its halves (a return mark when it missed), "reported" as a dotted
  //      underline, and the payout's time only when it differs from the trade's.
  //   B: A made compact: a pair icon (given, with received on its corner), the fee in sats, the price
  //      only in the sheet, and what came back on one line.
  //   C: B as a timeline: a rail with a dot per step (hollow while waiting), the pair as the title,
  //      each step with its own time; the sheet is the same timeline with each step's transaction.
  // Fixtures: the live sale (block 24546), a sale whose payout is still queued, a buy (the market
  // API's word), a sale that missed (token back on its result) and a buy that missed (ECX refunded).
  import AssetBadge from "$lib/AssetBadge.svelte";
  import ChainMark from "$lib/ChainMark.svelte";
  import broseveltLogo from "./brosevelt-logo";
  import Icon from "$lib/Icon.svelte";
  import Sheet from "$lib/Sheet.svelte";

  type Variant = "A" | "B" | "C";
  const VARIANTS: { key: Variant; name: string }[] = [
    { key: "A", name: "B, pair top to bottom" },
    { key: "B", name: "A, compact, pair icon" },
    { key: "C", name: "Double row, timeline" },
  ];
  let variant = $state<Variant>((new URLSearchParams(location.search).get("variant") as Variant) ?? "A");
  function go(step: number) {
    const i = VARIANTS.findIndex((v) => v.key === variant);
    variant = VARIANTS[(i + step + VARIANTS.length) % VARIANTS.length].key;
    const url = new URL(location.href);
    url.searchParams.set("variant", variant);
    history.replaceState(history.state, "", url);
    inspecting = undefined;
  }
  function onkey(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (t.closest("input, textarea, [contenteditable]")) return;
    if (e.key === "ArrowLeft") go(-1);
    if (e.key === "ArrowRight") go(1);
  }

  const ASSETS: Record<string, { ticker: string; decimals: number; ecx?: boolean; source?: "registration" }> = {
    ECX: { ticker: "ECX", decimals: 8, ecx: true },
    BROSEVELT: { ticker: "BROSEVELT", decimals: 2, source: "registration" },
    FORK: { ticker: "FORK", decimals: 6, source: "registration" },
  };
  /** Base units → "±1,234.5 TICKER". */
  function fmt(units: bigint, asset: string, sign = true): string {
    const { decimals, ticker } = ASSETS[asset];
    const neg = units < 0n;
    const abs = (neg ? -units : units).toString().padStart(decimals + 1, "0");
    const whole = BigInt(abs.slice(0, abs.length - decimals)).toLocaleString();
    const frac = abs.slice(abs.length - decimals).replace(/0+$/, "");
    return `${sign ? (neg ? "−" : "+") : ""}${whole}${frac ? "." + frac : ""} ${ticker}`;
  }

  type Amount = { asset: string; units: bigint; reported?: true };
  type Tx = { txid: string; role: "trade" | "payout" | "refund"; time: number; block: number; amounts: Amount[] };
  type Trade = {
    id: string;
    title: string;
    titlePending?: string;
    trade: Tx;
    /** The coinbase that paid its ECX: undefined while queued; null when nothing comes by coinbase. */
    payout: Tx | null | undefined;
    /** What's still to come while the payout is queued. */
    expected?: Amount;
    /** A line under the amounts: what came back on the result, or what the server reported. */
    note?: string;
    sheetNote?: string;
  };

  const T = 1793133825; // block 24546's time
  const TRADES: Trade[] = [
    {
      id: "sale",
      title: "Sold BROSEVELT",
      trade: { txid: "8010b0405bdcc99efb424f1625a697d573901831e8e9e63b0ac9245717a1f003", role: "trade", time: T, block: 24546, amounts: [{ asset: "BROSEVELT", units: -123400n }, { asset: "ECX", units: -393n }] },
      payout: { txid: "b09078b64ea98510d5e97b8036f6b416941c52a6c2ce59d8c705fa64b0eb3783", role: "payout", time: T, block: 24546, amounts: [{ asset: "ECX", units: 1210289n }] },
      sheetNote: "Paid in block 24546's coinbase, exactly what the market API reports this sale cleared at.",
    },
    {
      id: "queued",
      title: "Sold BROSEVELT",
      trade: { txid: "5c1d9e7a0b3f42d8a6e1c0f9b7d5e3a1c2f4b6d8e0a9c7b5d3f1e2a4c6b8d0e1", role: "trade", time: T - 900, block: 24489, amounts: [{ asset: "BROSEVELT", units: -50000n }, { asset: "ECX", units: -401n }] },
      payout: undefined,
      expected: { asset: "ECX", units: 489750n, reported: true },
      sheetNote: "It cleared in block 24489. Flush pays sales from a queue, in blocks that carry an eCash acknowledgement; this one hasn't been paid yet.",
    },
    {
      id: "buy",
      title: "Bought FORK",
      trade: { txid: "0f18f33870661a35f852082d03f5302e15e398c93d4e3956a3ffce03c9354e33", role: "trade", time: T - 3600, block: 24301, amounts: [{ asset: "FORK", units: 222412n, reported: true }, { asset: "ECX", units: -50388n }] },
      payout: null,
      sheetNote: "What you bought sits on the trade's result output. Only the node knows what that holds: the amount is the market API's word, not read from the chain.",
    },
    {
      id: "missedSale",
      title: "Sale didn't fill",
      trade: { txid: "a7e3c1f5d9b2486e0c4a8f2d6b1e9c3a5f7d0b8e2c4a6f1d3b5e7c9a0f2d4b6e8", role: "trade", time: T - 7200, block: 24112, amounts: [{ asset: "ECX", units: -393n }] },
      payout: null,
      note: "1,000 BROSEVELT returned",
      sheetNote: "The price moved below your minimum (0.0098 ECX), so the pool returned the 1,000 BROSEVELT on the trade's result output. Only the fee was spent.",
    },
    {
      id: "missedBuy",
      title: "Buy didn't fill",
      titlePending: "Buy didn't fill",
      trade: { txid: "e2b4d6f8a0c1e3b5d7f9a1c3e5b7d9f0a2c4e6b8d0f1a3c5e7b9d1f2a4c6e8b0d", role: "trade", time: T - 10800, block: 23950, amounts: [{ asset: "ECX", units: -100387n }] },
      payout: { txid: "3f5b7d9e1a2c4e6f8b0d2a4c6e8f0b1d3a5c7e9f1b2d4a6c8e0f2b3d5a7c9e1f0", role: "refund", time: T - 10785, block: 23951, amounts: [{ asset: "ECX", units: 100000n }] },
      sheetNote: "The price moved above your maximum, so Flush refunded the 0.001 ECX you paid in, in block 23951's coinbase. Only the fee was spent.",
    },
  ];
  /** An ordinary Received row around the trades, for density. */
  const PLAIN = { txid: "77aa…", time: T - 5400, amounts: [{ asset: "ECX", units: 2000000n }] as Amount[] };

  /** Net per asset over a trade's transactions, fee included. */
  function net(t: Trade): Amount[] {
    const m = new Map<string, Amount>();
    for (const tx of [t.trade, ...(t.payout ? [t.payout] : [])])
      for (const a of tx.amounts) {
        const prev = m.get(a.asset);
        m.set(a.asset, { asset: a.asset, units: (prev?.units ?? 0n) + a.units, ...(a.reported || prev?.reported ? { reported: true } : {}) });
      }
    return [...m.values()].filter((a) => a.units !== 0n).sort((a, b) => (a.units > 0n ? -1 : 1) - (b.units > 0n ? -1 : 1));
  }
  const timeOf = (s: number) => new Date(s * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const short = (txid: string) => `${txid.slice(0, 8)}…${txid.slice(-4)}`;
  const kindIcon = (t: Trade) => (t.title.startsWith("Bought") ? "receive" : t.title.includes("didn't") ? "refresh" : "send");

  let inspecting = $state<{ trade: Trade; tx?: Tx } | undefined>(undefined);
  let open = $state<Record<string, boolean>>({});
  let highlight = $state<string | undefined>(undefined);
  function jump(txid: string) {
    highlight = txid;
    inspecting = undefined;
    document.querySelector(`[data-tx="${txid}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    setTimeout(() => (highlight = undefined), 1500);
  }

  /**
   * B's two halves of a trade: what left the wallet (the trade, fee included) and what came back
   * (its coinbase payout or refund, or what its result output holds), each as it is, not netted.
   */
  type Back = { label: string; meta: string; amounts?: Amount[]; queued?: Amount };
  const LEGS: Record<string, { left: Amount[]; back: Back }> = {
    sale: { left: [{ asset: "BROSEVELT", units: -123400n }, { asset: "ECX", units: -393n }], back: { label: "Payout", meta: "coinbase · block 24546", amounts: [{ asset: "ECX", units: 1210289n }] } },
    queued: { left: [{ asset: "BROSEVELT", units: -50000n }, { asset: "ECX", units: -401n }], back: { label: "Payout", meta: "not paid yet", queued: { asset: "ECX", units: 489750n, reported: true } } },
    buy: { left: [{ asset: "ECX", units: -50388n }], back: { label: "Received", meta: "on the trade's result", amounts: [{ asset: "FORK", units: 222412n, reported: true }] } },
    missedSale: { left: [{ asset: "BROSEVELT", units: -100000n }, { asset: "ECX", units: -393n }], back: { label: "Returned", meta: "didn't fill · on the result", amounts: [{ asset: "BROSEVELT", units: 100000n }] } },
    missedBuy: { left: [{ asset: "ECX", units: -100387n }], back: { label: "Refund", meta: "didn't fill · coinbase · block 23951", amounts: [{ asset: "ECX", units: 100000n }] } },
  };

  /** A's take on the same legs: the traded amount alone above, the fee and price as small print. */
  type Refined = { title: string; traded: Amount; fee: bigint; price?: string; back: { label: string; when: string; amount: Amount; queued?: true; where: string } };
  const REFINED: Record<string, Refined> = {
    sale: {
      title: "Sold BROSEVELT",
      traded: { asset: "BROSEVELT", units: -123400n },
      fee: 393n,
      price: "at 0.00000981 ECX each",
      back: { label: "Paid", when: `at ${timeOf(T)}`, amount: { asset: "ECX", units: 1210289n }, where: "Coinbase b09078b6…3783 · block 24546" },
    },
    queued: {
      title: "Selling BROSEVELT",
      traded: { asset: "BROSEVELT", units: -50000n },
      fee: 401n,
      price: "at 0.00000980 ECX each",
      back: { label: "Payout queued", when: "Flush pays it in a coming block", amount: { asset: "ECX", units: 489750n, reported: true }, queued: true, where: "Not paid yet: the amount is the market API's word" },
    },
    buy: {
      title: "Bought FORK",
      traded: { asset: "ECX", units: -50000n },
      fee: 388n,
      price: "at 0.00224808 ECX each",
      back: { label: "Received", when: `at ${timeOf(T - 3600)}`, amount: { asset: "FORK", units: 222412n, reported: true }, where: "On the trade's result output: the amount is the market API's word" },
    },
    missedSale: {
      title: "Sale didn't fill",
      traded: { asset: "BROSEVELT", units: -100000n },
      fee: 393n,
      back: { label: "Returned", when: "the price fell below your minimum", amount: { asset: "BROSEVELT", units: 100000n }, where: "On the trade's result output" },
    },
    missedBuy: {
      title: "Buy didn't fill",
      traded: { asset: "ECX", units: -100000n },
      fee: 387n,
      back: { label: "Refunded", when: "the price rose above your maximum", amount: { asset: "ECX", units: 100000n }, where: "Coinbase 3f5b7d9e…c9e1f0 · block 23951" },
    },
  };
  const feeText = (sats: bigint) => `fee ${fmt(sats, "ECX", false)}`;

  /** C's timeline: the pair, and each step with its own time (none while waiting) and transaction. */
  type Step = { label: string; time?: number; amount: Amount; fee?: bigint; waiting?: string; tx?: string };
  type Timeline = { from: string; to: string; verb: string; missed?: true; steps: [Step, Step] };
  const TIMELINES: Record<string, Timeline> = {
    sale: {
      from: "BROSEVELT", to: "ECX", verb: "Sale",
      steps: [
        { label: "Sent to the pool", time: T, amount: { asset: "BROSEVELT", units: -123400n }, fee: 393n, tx: "8010b040…f003 · block 24546" },
        { label: "Paid", time: T, amount: { asset: "ECX", units: 1210289n }, tx: "b09078b6…3783 · block 24546 (coinbase)" },
      ],
    },
    queued: {
      from: "BROSEVELT", to: "ECX", verb: "Sale",
      steps: [
        { label: "Sent to the pool", time: T - 900, amount: { asset: "BROSEVELT", units: -50000n }, fee: 401n, tx: "5c1d9e7a…d0e1 · block 24489" },
        { label: "Payout", amount: { asset: "ECX", units: 489750n, reported: true }, waiting: "Queued" },
      ],
    },
    buy: {
      from: "ECX", to: "FORK", verb: "Buy",
      steps: [
        { label: "Sent to the pool", time: T - 3600, amount: { asset: "ECX", units: -50000n }, fee: 388n, tx: "0f18f338…4e33 · block 24301" },
        { label: "Received", time: T - 3600, amount: { asset: "FORK", units: 222412n, reported: true }, tx: "on the trade's result output" },
      ],
    },
    missedSale: {
      from: "BROSEVELT", to: "ECX", verb: "Sale", missed: true,
      steps: [
        { label: "Sent to the pool", time: T - 7200, amount: { asset: "BROSEVELT", units: -100000n }, fee: 393n, tx: "a7e3c1f5…b6e8 · block 24112" },
        { label: "Returned", time: T - 7200, amount: { asset: "BROSEVELT", units: 100000n }, tx: "on the trade's result output" },
      ],
    },
    missedBuy: {
      from: "ECX", to: "FORK", verb: "Buy", missed: true,
      steps: [
        { label: "Sent to the pool", time: T - 10800, amount: { asset: "ECX", units: -100000n }, fee: 387n, tx: "e2b4d6f8…b0d · block 23950" },
        { label: "Refunded", time: T - 10785, amount: { asset: "ECX", units: 100000n }, tx: "3f5b7d9e…e1f0 · block 23951 (coinbase)" },
      ],
    },
  };
</script>

<svelte:window onkeydown={onkey} />

{#snippet mark(asset: string, size: number)}
  {#if asset === "ECX"}
    <ChainMark kind="ecash" {size} />
  {:else}
    <ChainMark kind="asset" label={ASSETS[asset].ticker[0]} image={asset === "BROSEVELT" ? broseveltLogo : undefined} {size} />
  {/if}
{/snippet}

{#snippet amount(a: Amount, size: "in-row" | "in-sheet")}
  <span class="amount {size}" class:in={a.units > 0n} class:out={a.units < 0n} class:dotted={a.reported && variant === "A"} title={a.reported && variant === "A" ? "Reported by the market API: only the node knows what the trade's result holds" : undefined}>
    <span class="amark">{@render mark(a.asset, size === "in-row" ? 16 : 24)}</span>{fmt(a.units, a.asset)}<AssetBadge entry={ASSETS[a.asset]} />
    {#if a.reported && variant !== "A"}<span class="reported-mark" title="The market API's word: not read from the chain">reported</span>{/if}
  </span>
{/snippet}

{#snippet pending(t: Trade)}
  {#if t.payout === undefined && t.expected}
    <span class="amount in-row expected"><span class="amark">{@render mark(t.expected.asset, 16)}</span>{fmt(t.expected.units, t.expected.asset)} <span class="pill">Payout queued</span></span>
  {/if}
{/snippet}

{#snippet plainRow()}
  {#if variant === "C"}
    <!-- C: a plain transaction is a one-step timeline, so it reads like the trades around it. -->
    <li>
      <button class="row timeline">
        <span class="tl-head"><strong class="small">Received</strong></span>
        <span class="step">
          <span class="rail single"><span class="dot in"></span></span>
          <span class="grow"><span class="muted tiny meta">{timeOf(PLAIN.time)}</span></span>
          <span class="end">{#each PLAIN.amounts as a}{@render amount(a, "in-row")}{/each}</span>
        </span>
      </button>
    </li>
  {:else}
  <li>
    <button class="row">
      <span class="icon received"><Icon name="receive" size={16} /></span>
      <span class="grow"><strong class="small">Received</strong><span class="muted tiny meta">{timeOf(PLAIN.time)}</span></span>
      <span class="end">{#each PLAIN.amounts as a}{@render amount(a, "in-row")}{/each}</span>
    </button>
  </li>
  {/if}
{/snippet}

<main class="proto">
  <p class="banner">PROTOTYPE · variant {variant}: {VARIANTS.find((v) => v.key === variant)?.name}. Fixture data, nothing is read.</p>
  <h1 class="small">Flush · Activity</h1>

  <section class="day">
    <h2>Today</h2>
    <ul>
      {#if variant === "A"}
        {#each TRADES as t, i (t.id)}
          {@const r = REFINED[t.id]}
          {@const tl = TIMELINES[t.id]}
          {@const back = tl.steps[1]}
          {@const later = back.time !== undefined && timeOf(back.time) !== timeOf(t.trade.time)}
          {#if i === 3}{@render plainRow()}{/if}
          <li>
            <button class="row compact" onclick={() => (inspecting = { trade: t })}>
              <!-- The pair, top to bottom beside its halves: what was given, an arrow, what came back (a return mark if it missed). -->
              <span class="pair-col" title="{ASSETS[tl.from].ticker} → {ASSETS[tl.to].ticker}">
                <span class="p-top">{@render mark(tl.from, 22)}</span>
                <span class="p-arrow"><Icon name="chevron" size={12} /></span>
                {#if tl.missed}
                  <span class="p-bottom returned"><Icon name="refresh" size={12} /></span>
                {:else}
                  <span class="p-bottom" class:waiting={back.waiting}>{@render mark(tl.to, 22)}</span>
                {/if}
              </span>
              <span class="halves">
                <span class="half">
                  <span class="grow">
                    <strong class="small">{r.title}</strong>
                    <span class="muted tiny meta">{timeOf(t.trade.time)} · fee {r.fee} sat</span>
                  </span>
                  <span class="end">{@render amount(r.traded, "in-row")}</span>
                </span>
                <span class="half back line" class:waiting={back.waiting}>
                  <span class="grow small">
                    {r.back.label.replace("Payout queued", "Payout")}{#if back.waiting}{" "}<span class="pill">Queued</span>{:else if later}<span class="muted tiny"> · {timeOf(back.time!)}</span>{/if}
                  </span>
                  <span class="end">
                    {#if back.waiting}
                      <span class="amount in-row expected"><span class="amark">{@render mark(back.amount.asset, 16)}</span>≈ {fmt(back.amount.units, back.amount.asset)}</span>
                    {:else}
                      {@render amount(r.back.amount, "in-row")}
                    {/if}
                  </span>
                </span>
              </span>
            </button>
          </li>
        {/each}
      {:else if variant === "B"}
        {#each TRADES as t, i (t.id)}
          {@const r = REFINED[t.id]}
          {@const tl = TIMELINES[t.id]}
          {@const back = tl.steps[1]}
          {#if i === 3}{@render plainRow()}{/if}
          <li>
            <button class="row compact" onclick={() => (inspecting = { trade: t })}>
              <!-- The pair: what was given, with what came back on its corner. -->
              <span class="pair-icon" title="{ASSETS[tl.from].ticker} → {ASSETS[tl.to].ticker}">
                <span class="big">{@render mark(tl.from, 30)}</span>
                <span class="small-mark">{@render mark(tl.missed ? tl.from : tl.to, 18)}</span>
              </span>
              <span class="halves">
                <span class="half">
                  <span class="grow">
                    <strong class="small">{r.title}</strong>
                    <span class="muted tiny meta">{timeOf(t.trade.time)} · fee {r.fee} sat</span>
                  </span>
                  <span class="end">{@render amount(r.traded, "in-row")}</span>
                </span>
                <span class="half back line" class:waiting={back.waiting}>
                  <span class="grow small">
                    {r.back.label.replace("Payout queued", "Payout")}{#if back.waiting}{" "}<span class="pill">Queued</span>{:else if back.time !== undefined}<span class="muted tiny"> · {timeOf(back.time)}</span>{/if}
                  </span>
                  <span class="end">
                    {#if back.waiting}
                      <span class="amount in-row expected"><span class="amark">{@render mark(back.amount.asset, 16)}</span>≈ {fmt(back.amount.units, back.amount.asset)}</span>
                    {:else}
                      {@render amount(r.back.amount, "in-row")}
                    {/if}
                  </span>
                </span>
              </span>
            </button>
          </li>
        {/each}
      {:else}
        {#each TRADES as t, i (t.id)}
          {@const tl = TIMELINES[t.id]}
          {#if i === 3}{@render plainRow()}{/if}
          <li>
            <button class="row timeline" onclick={() => (inspecting = { trade: t })}>
              <span class="tl-head">
                <strong class="small pair">{@render mark(tl.from, 16)} {ASSETS[tl.from].ticker} <span class="arrow">→</span> {@render mark(tl.to, 16)} {ASSETS[tl.to].ticker}</strong>
                <span class="muted tiny">{tl.verb}</span>
                {#if tl.missed}<span class="pill warn">Didn't fill</span>{/if}
              </span>
              {#each tl.steps as s, k}
                <span class="step" class:waiting={s.waiting}>
                  <span class="rail" class:first={k === 0} class:last={k === 1}><span class="dot" class:hollow={s.waiting}></span></span>
                  <span class="grow">
                    <span class="small">{s.label}</span>
                    <span class="muted tiny meta">
                      {#if s.time !== undefined}{timeOf(s.time)}{:else}<span class="pill">{s.waiting}</span>{/if}
                      {#if s.fee !== undefined}<span>· {feeText(s.fee)}</span>{/if}
                    </span>
                  </span>
                  <span class="end">
                    {#if s.waiting}
                      <span class="amount in-row expected"><span class="amark">{@render mark(s.amount.asset, 16)}</span>≈ {fmt(s.amount.units, s.amount.asset)}</span>
                    {:else}
                      {@render amount(s.amount, "in-row")}
                    {/if}
                  </span>
                </span>
              {/each}
            </button>
          </li>
        {/each}
      {/if}
    </ul>
  </section>
</main>

{#if inspecting && (variant === "A" || variant === "B")}
  {@const t = inspecting.trade}
  {@const r = REFINED[t.id]}
  <Sheet title={r.title} onclose={() => (inspecting = undefined)}>
    <div class="sheet-legs">
      <div class="leg">
        <span class="muted tiny">You gave</span>
        {@render amount(r.traded, "in-sheet")}
        <span class="muted tiny">{feeText(r.fee)}{r.price ? ` · ${r.price}` : ""}</span>
      </div>
      <span class="leg-arrow"><Icon name="chevron" size={16} /></span>
      <div class="leg" class:waiting={r.back.queued}>
        <span class="muted tiny">{r.back.label}</span>
        {#if r.back.queued}
          <span class="amount in-sheet expected"><span class="amark">{@render mark(r.back.amount.asset, 24)}</span>≈ {fmt(r.back.amount.units, r.back.amount.asset)}</span>
        {:else}
          {@render amount(r.back.amount, "in-sheet")}
        {/if}
        <span class="muted tiny">{r.back.when}</span>
      </div>
    </div>
    <dl class="facts">
      <dt>Trade</dt>
      <dd><code>{short(t.trade.txid)}</code> · block {t.trade.block}</dd>
      <dt>{r.back.label}</dt>
      <dd class="tiny">{r.back.where}</dd>
    </dl>
    {#if t.sheetNote}<p class="muted small">{t.sheetNote}</p>{/if}
    <p class="reported">The wallet paired these by the trade's order: its payout address and the amount the market API reports. Nothing on the chain links them.</p>
  </Sheet>
{:else if inspecting && variant === "C"}
  {@const t = inspecting.trade}
  {@const tl = TIMELINES[t.id]}
  <Sheet title="{tl.verb}: {ASSETS[tl.from].ticker} → {ASSETS[tl.to].ticker}" onclose={() => (inspecting = undefined)}>
    {#if tl.missed}<p class="pill warn sheet-pill">Didn't fill</p>{/if}
    <ol class="sheet-steps">
      {#each tl.steps as s, k}
        <li class="step" class:waiting={s.waiting}>
          <span class="rail" class:first={k === 0} class:last={k === 1}><span class="dot" class:hollow={s.waiting}></span></span>
          <span class="grow">
            <span class="small">{s.label}{s.time !== undefined ? ` · ${timeOf(s.time)}` : ""}</span>
            {#if s.waiting}
              <span class="amount in-sheet expected"><span class="amark">{@render mark(s.amount.asset, 24)}</span>≈ {fmt(s.amount.units, s.amount.asset)}</span>
            {:else}
              {@render amount(s.amount, "in-sheet")}
            {/if}
            {#if s.fee !== undefined}<span class="muted tiny">{feeText(s.fee)}</span>{/if}
            <span class="muted tiny mono">{s.tx ?? "not paid yet: the amount is the market API's word"}</span>
          </span>
        </li>
      {/each}
    </ol>
    {#if t.sheetNote}<p class="muted small">{t.sheetNote}</p>{/if}
    <p class="reported">The wallet paired these by the trade's order: its payout address and the amount the market API reports. Nothing on the chain links them.</p>
  </Sheet>
{:else if inspecting}
  {@const { trade: t, tx } = inspecting}
  {@const title = tx === undefined ? t.title : tx.role === "payout" ? "Trade payout" : tx.role === "refund" ? "Trade refund" : t.title}
  <Sheet {title} onclose={() => (inspecting = undefined)}>
    <div class="sheet-amounts">
      {#each tx === undefined ? net(t) : tx.amounts as a (a.asset)}{@render amount(a, "in-sheet")}{/each}
      {#if !tx}{@render pending(t)}{/if}
    </div>
    <dl class="facts">
      <dt>Status</dt>
      <dd>{t.payout === undefined ? "Traded; payout queued" : "Confirmed"}</dd>
      {#if tx === undefined}
        <dt>Trade</dt>
        <dd>
          <code>{short(t.trade.txid)}</code> · block {t.trade.block}<br />
          {#each t.trade.amounts as a}<span class="tiny">{fmt(a.units, a.asset)}</span>{" "}{/each}
        </dd>
        {#if t.payout}
          <dt>{t.payout.role === "payout" ? "Paid by" : "Refunded by"}</dt>
          <dd>
            <code>{short(t.payout.txid)}</code> · block {t.payout.block} (coinbase)<br />
            {#each t.payout.amounts as a}<span class="tiny">{fmt(a.units, a.asset)}</span>{/each}
          </dd>
        {/if}
      {:else}
        <dt>Transaction</dt>
        <dd><code>{short(tx.txid)}</code> · block {tx.block}</dd>
        {#if variant === "B"}
          {@const other = tx.role === "trade" ? t.payout : t.trade}
          {#if other}
            <dt>{tx.role === "trade" ? "Paid by" : "For"}</dt>
            <dd><button class="link" onclick={() => jump(other.txid)}>{tx.role === "trade" ? "its payout" : t.title.toLowerCase()} <code>{short(other.txid)}</code></button></dd>
          {/if}
        {/if}
      {/if}
    </dl>
    {#if t.sheetNote}<p class="muted small">{t.sheetNote}</p>{/if}
    <p class="reported">The wallet paired these by the trade's order: its payout address and the amount the market API reports. Nothing on the chain links them.</p>
  </Sheet>
{/if}

{#if import.meta.env.DEV}
  <div class="switcher" role="toolbar" aria-label="Prototype variants">
    <button onclick={() => go(-1)} aria-label="Previous variant">←</button>
    <span>{variant} ({VARIANTS.find((v) => v.key === variant)?.name})</span>
    <button onclick={() => go(1)} aria-label="Next variant">→</button>
  </div>
{/if}

<style>
  .proto {
    max-width: 380px;
    margin: 0 auto;
    padding: 16px 16px 96px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .banner {
    padding: 4px 8px;
    border: 1px dashed var(--warn);
    border-radius: var(--radius-sm);
    color: var(--warn);
    font-size: 0.75rem;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  /* From ActivityFeed.svelte, so the rows read as the real ones. */
  .day {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: 56px;
    padding: 8px 0;
    border: none;
    border-bottom: 1px solid var(--border);
    border-radius: 0;
    background: none;
    font-weight: 400;
    text-align: left;
    transition: background 0.3s;
  }
  .row:hover {
    background: color-mix(in srgb, var(--accent) 5%, transparent);
  }
  .row.flash {
    background: color-mix(in srgb, var(--accent) 20%, transparent);
  }
  /* B: one tap target, two lines of a row's height each; the icon spans both. */
  .row.double {
    min-height: 104px;
  }
  .halves {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .half {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 44px;
  }
  .half.back {
    border-top: 1px dashed var(--border);
  }
  .half.waiting {
    color: var(--muted);
  }
  /* B: shorter than A; the second half is one line. */
  .row.compact {
    min-height: 80px;
  }
  .half.line {
    min-height: 30px;
  }
  .half.line .grow {
    flex-direction: row;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 4px;
  }
  .pair-icon {
    position: relative;
    flex: none;
    width: 36px;
    height: 36px;
  }
  .pair-icon .big {
    position: absolute;
    top: 0;
    left: 0;
  }
  .pair-icon .small-mark {
    position: absolute;
    right: -2px;
    bottom: -2px;
    border-radius: 50%;
    box-shadow: 0 0 0 2px var(--bg);
    display: inline-flex;
  }
  /* A: the given asset level with the top half, the received one with the bottom, an arrow between. */
  .pair-col {
    flex: none;
    align-self: stretch;
    width: 36px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: space-between;
    padding: 10px 0 6px;
  }
  .pair-col .p-top,
  .pair-col .p-bottom {
    display: inline-flex;
    border-radius: 50%;
  }
  .pair-col .p-bottom.waiting {
    opacity: 0.45;
  }
  .pair-col .returned {
    width: 22px;
    height: 22px;
    align-items: center;
    justify-content: center;
    background: var(--warn-bg);
    color: var(--warn);
  }
  /* Icon's chevron points down as drawn. */
  .p-arrow {
    display: inline-flex;
    color: var(--muted);
  }
  .pair-row {
    position: relative;
    flex: none;
    width: 40px;
    height: 24px;
  }
  .pair-row .p1,
  .pair-row .p2 {
    position: absolute;
    top: 0;
    display: inline-flex;
    border-radius: 50%;
  }
  .pair-row .p1 {
    left: 0;
  }
  .pair-row .p2 {
    left: 16px;
    box-shadow: 0 0 0 2px var(--bg);
  }
  .pair-row .returned {
    width: 24px;
    height: 24px;
    align-items: center;
    justify-content: center;
    background: var(--warn-bg);
    color: var(--warn);
  }
  .amount.dotted {
    text-decoration: underline dotted;
    text-underline-offset: 3px;
    cursor: help;
  }
  .icon.swap {
    color: var(--accent-text);
  }
  .sheet-legs {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    text-align: center;
  }
  .leg {
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  .leg.waiting {
    color: var(--muted);
  }
  /* C: a header line, then two steps on a rail. */
  .row.timeline {
    flex-direction: column;
    align-items: stretch;
    gap: 0;
  }
  .tl-head {
    display: flex;
    align-items: baseline;
    gap: 6px;
    padding-bottom: 2px;
  }
  .arrow {
    color: var(--muted);
    font-weight: 400;
  }
  .step {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 40px;
  }
  .step.waiting {
    color: var(--muted);
  }
  .rail {
    position: relative;
    align-self: stretch;
    flex: none;
    width: 14px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .rail::before {
    content: "";
    position: absolute;
    left: 6px;
    width: 2px;
    top: 0;
    bottom: 0;
    background: var(--border);
  }
  .rail.first::before {
    top: 50%;
  }
  .rail.last::before {
    bottom: 50%;
  }
  .dot {
    position: relative;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--accent-text);
  }
  .rail.single::before {
    display: none;
  }
  .dot.in {
    background: var(--ok);
  }
  .dot.hollow {
    background: var(--bg);
    border: 2px solid var(--muted);
  }
  .pill.warn {
    background: var(--warn-bg);
    color: var(--warn);
  }
  .sheet-pill {
    align-self: center;
  }
  .sheet-steps {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .sheet-steps .step {
    min-height: 88px;
  }
  .leg-arrow {
    color: var(--muted);
  }
  .icon {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: var(--surface-2);
    color: var(--text);
  }
  .icon.received {
    color: var(--ok);
  }
  .grow {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .end {
    flex: none;
    max-width: 60%;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    text-align: right;
  }
  .amount {
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .amark {
    display: inline-flex;
    vertical-align: -2px;
    margin-right: 4px;
  }
  /* ChainMark's letter is 36% of its disc, made for 32 px marks: at row size it's a smudge. */
  .amark :global(.mark.asset),
  .pair :global(.mark.asset),
  .small-mark :global(.mark.asset) {
    font-size: 10px !important;
  }
  .amark :global(.mark) {
    vertical-align: -3px;
  }
  .pair {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .amount.in-row {
    font-size: 0.85rem;
  }
  .amount.in-sheet {
    font-size: 1.5rem;
  }
  .amount.in {
    color: var(--ok);
  }
  .amount.out {
    color: var(--danger);
  }
  .expected {
    color: var(--muted);
    font-weight: 500;
  }
  .reported-mark {
    margin-left: 4px;
    padding: 0 4px;
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--muted);
    font-size: 0.65rem;
    font-weight: 500;
    vertical-align: middle;
  }
  .pill {
    padding: 0 6px;
    border-radius: 999px;
    background: var(--pending-bg);
    color: var(--pending);
    font-size: 0.7rem;
    font-weight: 600;
  }
  .chev {
    flex: none;
    color: var(--muted);
    transform: rotate(90deg);
    transition: transform 0.15s;
  }
  .chev.turned {
    transform: rotate(-90deg);
  }
  .parts {
    margin: 0 0 6px 48px;
    border-left: 2px solid var(--border);
  }
  .part {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 0 6px 10px;
    border: none;
    border-radius: 0;
    background: none;
    font-weight: 400;
    text-align: left;
  }
  li.part {
    padding: 6px 0 6px 10px;
  }
  .sheet-amounts {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
  }
  .facts {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 6px 12px;
    font-size: 0.85rem;
  }
  .facts dt {
    color: var(--muted);
  }
  .facts code {
    font-size: 0.72rem;
  }
  .reported {
    color: var(--muted);
    font-size: 0.75rem;
    font-style: italic;
  }
  .switcher {
    position: fixed;
    bottom: 16px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 10px;
    border-radius: 999px;
    background: #111;
    color: #fff;
    box-shadow: 0 4px 16px rgb(0 0 0 / 0.35);
    font: 600 0.8rem system-ui;
    z-index: 1000;
  }
  .switcher button {
    min-height: 28px;
    width: 28px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: #333;
    color: #fff;
  }
</style>
