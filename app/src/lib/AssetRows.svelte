<script lang="ts">
  import { shortAsset } from "$lib/asset";
  import AssetBadge from "$lib/AssetBadge.svelte";
  import ChainMark from "$lib/ChainMark.svelte";
  import { assetMark, chainMark, type ChainView } from "$lib/chains.svelte";
  import Icon from "$lib/Icon.svelte";
  import { amountText, assetsOf } from "$lib/unit.svelte";

  /** One chain's assets as its server reports them, each named as its Chain Entry names it. */
  let { view, onretry, onreceive }: { view: ChainView; onretry: () => void; onreceive: () => void } = $props();

  const report = $derived(view.shown.report);
  const readAt = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
</script>

{#if view.shown.error !== undefined}
  <p class="problem small" data-balance-error title={view.shown.error}>
    <!-- The server's own message already says what went wrong ("Couldn't reach …", another chain). -->
    <span>{report ? `Couldn't refresh the balance: ${view.shown.error}` : view.shown.error}</span>
    <button class="link" onclick={onretry} data-retry><Icon name="refresh" size={12} /> Retry</button>
  </p>
{/if}
{#if report === undefined}
  {#if view.shown.error === undefined}
    <p class="loading small"><span class="spinner"></span>Asking its server for your balance…</p>
  {/if}
{:else}
  {#if view.shown.refreshing || view.shown.error !== undefined}
    <p class="muted tiny read-at" data-read-at>
      {#if view.shown.refreshing}<span class="spinner"></span>{/if}
      Last read at {readAt(report.readAt)}{view.shown.refreshing ? "; refreshing…" : "."}
    </p>
  {/if}
  <ul class="stagger">
    {#each assetsOf(report) as { asset, amount, unconfirmed, unverified, indexed }, i (asset)}
      {@const entry = view.info.assets.find((a) => a.id === asset)}
      <li class="asset" style:--i={i} data-asset={asset}>
        <span class="icon">
          <ChainMark {...assetMark(entry)} size={36} />
          <!-- On a sidechain, its mark on the asset's: which chain this ECX or token is on. -->
          {#if view.info.id !== "l1"}<span class="on-chain"><ChainMark {...chainMark(view.info)} size={16} /></span>{/if}
        </span>
        <span class="name">
          <strong class="ticker"><span class="ticker-text">{entry ? entry.ticker : "Unknown asset"}</span><AssetBadge {entry} size={10} /></strong>
          <span class="muted tiny">
            {#if entry}{entry.name}{:else}
              <code title={asset}>{shortAsset(asset)}</code>
              {#if view.info.id !== "l1"}<a class="link" href="#/assets/{view.info.id}/{asset}" data-name-asset>Name it</a>{/if}
            {/if}
          </span>
        </span>
        <span class="amounts">
          <strong
            class="amount"
            class:indexed={indexed !== undefined}
            title={indexed === undefined
              ? undefined
              : `${indexed === amount ? "All" : amountText(indexed, asset, view.info.assets)} of it from trades, as the market index reports their outcome. Each fits what the trade asked for; it can't be sent from this wallet yet.`}
            data-balance
            data-indexed={indexed}
            data-asset={asset}>{amountText(amount, asset, view.info.assets)}</strong
          >
          {#if unconfirmed !== undefined}
            <span class="tiny pending" data-unconfirmed data-asset={asset}>+{amountText(unconfirmed, asset, view.info.assets)} unconfirmed</span>
          {/if}
          {#if unverified !== undefined}
            <span
              class="tiny muted"
              data-unverified
              data-asset={asset}
              title="On outputs whose token no transaction states (a swap's, a pool withdrawal's): only its server says so."
              >+{amountText(unverified, asset, view.info.assets)} reported by its server</span
            >
          {/if}
        </span>
      </li>
    {:else}
      <li class="muted small empty" data-no-balance>
        No assets yet. <button class="link" onclick={onreceive}>Receive on {view.info.name}</button>
      </li>
    {/each}
  </ul>
{/if}

<style>
  ul {
    display: flex;
    flex-direction: column;
  }
  .asset {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 60px;
    padding: 8px 12px;
    border-radius: var(--radius-sm);
    transition: background-color 0.15s;
  }
  .asset:hover {
    background: color-mix(in srgb, var(--surface-2) 70%, transparent);
  }
  .icon {
    position: relative;
    flex: none;
    display: flex;
  }
  .on-chain {
    position: absolute;
    right: -4px;
    bottom: -3px;
    display: flex;
    border: 2px solid var(--bg);
    border-radius: 50%;
  }
  .name {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  /* The ticker and its trust mark stay on one line: a long ticker is cut short, never the mark. */
  .ticker {
    display: flex;
    align-items: center;
    min-width: 0;
  }
  .ticker-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .amounts {
    flex: none;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    text-align: right;
  }
  .amount {
    font-weight: 600;
  }
  .pending {
    color: var(--pending);
  }
  /* Some of it is the market index's word: underlined dotted, as a trade's outcome is. */
  .indexed {
    text-decoration: underline dotted color-mix(in srgb, var(--muted) 70%, transparent);
    text-underline-offset: 3px;
    cursor: help;
  }
  .empty {
    padding: 10px 12px;
  }
  .problem {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 8px;
    padding: 0 0 10px 12px;
    color: var(--danger);
    overflow-wrap: anywhere;
  }
  .read-at {
    display: flex;
    align-items: center;
    gap: 6px;
    padding-left: 12px;
  }
  .read-at .spinner {
    width: 12px;
    height: 12px;
  }
  .loading {
    padding: 4px 0 10px 12px;
  }
</style>
