<script lang="ts">
  // The wallet's ordinary coins on the Sidepot sidechain (docs/adr/0022), on Sidepot's own screen
  // beside its game balance: what its server reports of the wallet's address there, the address to
  // receive at, where to send and withdraw from, and the withdrawal requests still waiting.
  import { onMount } from "svelte";
  import { coinsAddress, coinsReported, forgetWithdrawal, getRereadSeconds, onChainsChanged, type ChainInfo, type ShownReport, type SidepotCoinsReport } from "$lib/background";
  import Icon from "$lib/Icon.svelte";
  import QrCode from "$lib/QrCode.svelte";
  import Sheet from "$lib/Sheet.svelte";
  import { amountText } from "$lib/unit.svelte";

  /**
   * `reportedBy`: the server whose report this card shows, for the screen's one "Reported by" notice
   * (the chain's screen prints it, covering this card and the chain's own balance).
   */
  let { slot, info, reportedBy = $bindable() }: { slot: number; info: ChainInfo; reportedBy?: string } = $props();

  let shown = $state<ShownReport<SidepotCoinsReport>>({ refreshing: true });
  /** The wallet's Sidepot address: its own to derive, so it shows even when the server can't be read. */
  let address = $state<string | undefined>(undefined);
  let receiving = $state(false);
  let copied = $state(false);

  const sats = (amount: string) => amountText(amount, "", info.assets);
  const readAt = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  /** When a history entry's block was mined, as a short date and time. */
  const minedAt = (seconds: number) => new Date(seconds * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  type CoinEvent = NonNullable<SidepotCoinsReport["history"]>[number];
  /** What a history entry was, in words. */
  function eventTitle(e: CoinEvent): string {
    if (e.kind === "cashout") return "Cashed out from the game";
    if (e.kind === "deposit") return "Deposit from the main chain";
    if (e.kind === "withdrawal") return "Withdrawal request";
    return e.amount.startsWith("-") ? "Sent" : "Received";
  }
  /** How far a history entry's withdrawal request has got, by the node's account of its bundle. */
  const PROGRESS = {
    waiting: "Waiting for a withdrawal bundle.",
    voting: "Its bundle is with the main chain's miners.",
    paid: "Paid on the main chain.",
    failed: "Its bundle failed. It waits for the next one.",
  };
  /** A signed amount of sats, with its sign in front. */
  const signed = (amount: string) => (amount.startsWith("-") ? `-${sats(amount.slice(1))}` : `+${sats(amount)}`);

  /** The last report read, kept on show while the next is read. */
  let last: SidepotCoinsReport | undefined;
  let reading = false;

  /** Reads the coins again. `unattended`: the page does it by itself, which isn't activity (the auto-lock). */
  function read(unattended = false) {
    if (reading) return;
    reading = true;
    shown = { report: last, refreshing: true };
    coinsReported(slot, unattended)
      .then(
        (report) => (shown = { report: (last = report), refreshing: false }),
        (e) => (shown = { report: last, refreshing: false, error: (e as Error).message }),
      )
      .finally(() => (reading = false));
  }

  onMount(() => {
    coinsAddress(slot).then((a) => (address = a), () => {});
    read();
    // After one of the wallet's own transactions on this chain, and every so often while on screen.
    const stopChanged = onChainsChanged((ids) => ids.includes(slot) && read(true));
    let timer: ReturnType<typeof setInterval> | undefined;
    getRereadSeconds().then((seconds) => (timer = setInterval(() => document.visibilityState === "visible" && read(true), seconds * 1000)), () => {});
    return () => {
      stopChanged();
      clearInterval(timer);
    };
  });

  const report = $derived(shown.report);
  $effect(() => {
    reportedBy = report?.server;
  });
  const canSpend = $derived(report !== undefined && shown.error === undefined && report.balance !== "0");

  /** Where a withdrawal request stands, in words (`WithdrawalStatus`). */
  const WITHDRAWAL_STATUS = $derived({
    sent: `Sent. It shows as waiting once it is in a ${info.name} block.`,
    waiting: `Waiting for ${info.name} to put it in a withdrawal bundle.`,
    bundled: `In ${info.name}'s next withdrawal bundle, which hasn't gone to the main chain yet.`,
    handedOver:
      `${info.name}'s server no longer lists it, so its bundle has gone to the main chain. The miners' vote on a bundle takes a long time, and this wallet ` +
      "can't follow it or see the payment. If the bundle fails, the withdrawal shows as waiting again.",
    unlisted: `${info.name}'s server never listed it, so it may not have been included. If your coins are back in your balance, nothing was withdrawn.`,
  });

  /** Stops showing a request only the wallet's own record has; the request itself is unaffected. */
  async function forget(id: string) {
    await forgetWithdrawal(slot, id).catch(() => {});
    read();
  }

  function copy(text: string) {
    navigator.clipboard.writeText(text).catch(() => {});
    copied = true;
    setTimeout(() => (copied = false), 1500);
  }
</script>

<section class="card coins" data-coins data-coins-server={report?.server} data-refreshing={shown.refreshing ? "" : undefined}>
  <div class="head">
    <h2>Coins on {info.name}</h2>
    <span class="muted tiny">
      Ordinary coins at your own {info.name} address, apart from the game balance above. A cashout from the game arrives here.
    </span>
  </div>

  {#if report}
    <strong class="amount" data-coins-balance>{sats(report.balance)}</strong>
    {#if report.held !== "0"}
      <span class="muted small" data-coins-held>{sats(report.held)} held by a transaction waiting to confirm</span>
    {/if}
    {#if shown.refreshing}
      <p class="muted tiny read-at" data-coins-read-at><span class="spinner"></span>Last read at {readAt(report.readAt)}; refreshing…</p>
    {/if}
  {:else if shown.refreshing}
    <p class="loading small"><span class="spinner"></span>Asking its server for your coins…</p>
  {/if}
  {#if shown.error !== undefined}
    <p class="error small" data-coins-error>
      {report ? `Couldn't refresh your coins (showing ${readAt(report.readAt)}'s)` : "Couldn't read your coins"}: {shown.error}
      <button class="link" onclick={() => read()} data-coins-retry><Icon name="refresh" size={12} /> Retry</button>
    </p>
  {/if}

  <nav class="row">
    <button class="small-button" onclick={() => (receiving = true)} data-coins-receive><Icon name="receive" size={16} />Receive</button>
    <a class="button small-button" class:off={!canSpend} href="#/coins/{slot}/send" aria-disabled={!canSpend} data-coins-send>
      <Icon name="send" size={16} />Send
    </a>
    <a class="button small-button" class:off={!canSpend} href="#/coins/{slot}/withdraw" aria-disabled={!canSpend} data-coins-withdraw>
      <Icon name="deposit" size={16} />Withdraw
    </a>
  </nav>

  {#if report && report.withdrawals.length > 0}
    <div class="stack" data-coins-withdrawals>
      <h3>Withdrawals waiting</h3>
      <ul class="stack">
        {#each report.withdrawals as w (w.id)}
          <li class="withdrawal" data-coins-withdrawal={w.status}>
            <span>
              <strong class="amount" data-withdrawal-amount>{sats(w.amount)}</strong>
              <span class="muted small">to the main chain, plus a {sats(w.mainFee)} main-chain fee</span>
            </span>
            <code class="tiny" data-withdrawal-address>{w.mainAddress}</code>
            <span class="muted tiny" data-withdrawal-status>{WITHDRAWAL_STATUS[w.status]}</span>
            {#if w.forgettable}
              <button class="link" onclick={() => forget(w.id)} data-withdrawal-forget>Stop showing it</button>
            {/if}
          </li>
        {/each}
      </ul>
      <p class="muted tiny">
        A withdrawal takes a long time, and the main chain's miners decide whether its bundle is paid. This wallet can show it only while
        {info.name}'s server lists it.
      </p>
    </div>
  {/if}

  {#if report?.history && report.history.length > 0}
    <div class="stack" data-coins-history>
      <h3>Coin activity</h3>
      <ul class="stack">
        {#each report.history as e (e.id)}
          <li class="event" data-coins-event={e.kind}>
            <span class="event-line">
              <span>{eventTitle(e)}</span>
              <strong class:out={e.amount.startsWith("-")} data-event-amount>{signed(e.amount)}</strong>
            </span>
            {#if e.withdrawal}
              <span class="muted tiny" data-event-withdrawal={e.withdrawal.progress}>
                {sats(e.withdrawal.amount)} to {e.withdrawal.mainAddress}. {PROGRESS[e.withdrawal.progress]}
              </span>
            {/if}
            <span class="muted tiny">
              {e.time !== undefined ? minedAt(e.time) : e.height !== undefined ? `${info.name} block ${e.height}` : "In a block"}{#if e.txid}
                , <code class="tiny">{e.txid.slice(0, 10)}…{e.txid.slice(-6)}</code>{/if}
            </span>
          </li>
        {/each}
      </ul>
    </div>
  {/if}
</section>

{#if receiving}
  <Sheet title="Your {info.name} address" onclose={() => (receiving = false)} data-coins-receive-sheet>
    <p class="muted tiny">
      For coins on the {info.name} sidechain: give it to the game as the address to cash out to, or to someone sending you {info.name}
      coins. To fund your game account from the main chain, use Deposit instead.
    </p>
    {#if address}
      <div class="qr"><QrCode text={address} /></div>
      <div class="address-line">
        <code class="address" data-coins-address>{address}</code>
        <button class="copy" aria-label="Copy your {info.name} address" title="Copy address" onclick={() => copy(address!)} data-coins-copy-address>
          <Icon name={copied ? "check" : "copy"} size={16} />
        </button>
      </div>
      <p class="muted tiny only">Only for {info.name} (<span class="mono">{info.chain}</span>). It isn't a main-chain address.</p>
    {:else}
      <p class="loading small"><span class="spinner"></span>Deriving the address…</p>
    {/if}
  </Sheet>
{/if}

<style>
  .event {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .event-line {
    display: flex;
    justify-content: space-between;
    gap: 12px;
  }
  .event-line strong {
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .coins {
    margin-top: 4px;
  }
  .head {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  h2 {
    font-size: 1rem;
  }
  h3 {
    font-size: 0.9rem;
  }
  .amount {
    font-size: 1.4rem;
  }
  .withdrawal .amount {
    font-size: 1rem;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .row > * {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    text-decoration: none;
  }
  .off {
    opacity: 0.45;
    pointer-events: none;
  }
  .read-at {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .withdrawal {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .withdrawal code {
    overflow-wrap: anywhere;
  }
  .qr {
    align-self: center;
  }
  .address-line {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .address {
    flex: 1;
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    font-size: 0.8rem;
    overflow-wrap: anywhere;
    user-select: all;
  }
  .copy {
    width: 32px;
    min-height: 32px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: none;
    color: var(--muted);
  }
  .only {
    text-align: center;
  }
</style>
