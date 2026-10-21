<script lang="ts">
  import { page } from "$app/state";
  import { cachedHistory, reportedHistory, showReport, type ChainHistory, type HistoryEntry, type ShownReport } from "$lib/background";
  import { shortAsset } from "$lib/asset";
  import Icon from "$lib/Icon.svelte";
  import TopBar from "$lib/TopBar.svelte";

  /** `l1` for eCash, else a Slot. */
  const slot = page.params.chain === "l1" ? undefined : Number(page.params.chain);
  const title = slot === undefined ? "eCash history" : `Slot ${slot} history`;
  /** What the chain's server reports (this session's last while refreshing), or why it couldn't be read. */
  let shown = $state<ShownReport<ChainHistory>>({ refreshing: true });

  showReport(() => cachedHistory(slot), () => reportedHistory(slot), (next) => (shown = next));

  const readAt = (history: ChainHistory) => new Date(history.readAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const minedAt = (time: number) => new Date(time * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  const shortTxid = (txid: string) => `${txid.slice(0, 8)}…${txid.slice(-8)}`;
  const signed = (amount: string) => (amount.startsWith("-") ? `−${amount.slice(1)}` : `+${amount}`);

  function copy(txid: string) {
    navigator.clipboard.writeText(txid).catch(() => {});
  }
</script>

{#snippet netAmount({ asset, amount }: { asset: string; amount: string })}
  <span class="amount" class:out={amount.startsWith("-")} data-history-amount data-asset={asset}>
    {signed(amount)}
    {#if asset === ""}sats{:else}<span class="muted small">asset <code title={asset}>{shortAsset(asset)}</code></span>{/if}
  </span>
{/snippet}

{#snippet historyEntry(entry: HistoryEntry)}
  <li
    class="entry"
    data-history-entry={entry.txid}
    data-history-state={entry.confirmed ? "confirmed" : entry.trusted ? "pending" : "unconfirmed"}
  >
    <div class="amounts">
      {#each entry.amounts as net (net.asset)}
        {@render netAmount(net)}
      {/each}
      {#if entry.hidden}
        <span class="muted small" data-history-hidden>
          {entry.amounts.length > 0 ? "+ confidential amounts not shown" : "Amount hidden (confidential)"}
        </span>
      {/if}
    </div>
    {#if entry.depositTo !== undefined}
      <span class="small" data-history-label>Deposit to Slot {entry.depositTo}</span>
    {:else if entry.toSelf}
      <span class="small" data-history-label>Fee, to yourself</span>
    {/if}
    <div class="meta small">
      {#if entry.confirmed}
        <span class="muted" data-history-status>
          {#if entry.time !== undefined}<time datetime={new Date(entry.time * 1000).toISOString()}>{minedAt(entry.time)}</time>{:else}Confirmed{/if}
        </span>
      {:else if entry.trusted}
        <span class="badge" data-history-status>Pending</span>
      {:else}
        <span class="badge warn" title="Sent by someone else; may still not arrive" data-history-status>Unconfirmed</span>
      {/if}
      <span class="txid">
        <code title={entry.txid} data-history-txid>{shortTxid(entry.txid)}</code>
        <button class="icon-button" aria-label="Copy transaction id" title="Copy transaction id" onclick={() => copy(entry.txid)}>
          <Icon name="copy" size={14} />
        </button>
      </span>
    </div>
  </li>
{/snippet}

<main class="screen" data-screen-ready>
  <TopBar {title} back="#/" />

  <section class="card" data-history data-refreshing={shown.refreshing ? "" : undefined}>
    {#if shown.error !== undefined}
      <p class="error small" data-history-error>
        {shown.report ? "Couldn't refresh" : "History unavailable"}: {shown.error}
      </p>
    {/if}
    {#if shown.report === undefined}
      {#if shown.error === undefined}
        <p class="loading small"><span class="spinner"></span>Asking the Sidechain Server for your transactions…</p>
      {/if}
    {:else}
      {#if shown.report.entries.length === 0}
        <p class="muted" data-history-empty>No transactions yet.</p>
      {:else}
        <ul class="entries">
          {#each shown.report.entries as entry (entry.txid)}
            {@render historyEntry(entry)}
          {/each}
        </ul>
        {#if shown.report.partial}
          <p class="muted small" data-history-more>Older transactions may not be shown.</p>
        {/if}
      {/if}
      <p class="reported" data-reported-by>Reported by {shown.report.server}. This wallet doesn't verify it.</p>
      {#if shown.refreshing}
        <p class="muted small" data-read-at><span class="spinner"></span>Last read at {readAt(shown.report)}; refreshing…</p>
      {:else if shown.error !== undefined}
        <p class="muted small" data-read-at>Last read at {readAt(shown.report)}.</p>
      {/if}
    {/if}
  </section>
</main>

<style>
  .entries {
    display: flex;
    flex-direction: column;
  }
  .entry {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 10px 0;
    border-bottom: 1px solid var(--border);
  }
  .entry:first-child {
    padding-top: 0;
  }
  .amounts {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .amount {
    font-weight: 600;
    color: var(--ok);
  }
  .amount.out {
    color: var(--text);
  }
  .meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .txid {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .badge {
    padding: 1px 8px;
    border-radius: 999px;
    background: var(--surface-2);
    color: var(--muted);
  }
  .badge.warn {
    background: var(--warn-bg);
    color: var(--warn);
    cursor: help;
  }
  .icon-button {
    display: flex;
    padding: 2px;
    border: none;
    background: none;
    color: var(--muted);
    cursor: pointer;
  }
</style>
