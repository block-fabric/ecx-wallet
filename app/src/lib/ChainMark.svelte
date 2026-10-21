<script lang="ts">
  import EcashLogo from "$lib/EcashLogo.svelte";

  /**
   * A chain's or an asset's mark: eCash's own on a near-black disc for the main chain and every
   * ECX; Elements+'s initials on its purple; anything else its first letter, or "?" when unnamed.
   */
  let { kind, label = "", size = 32 }: { kind: "ecash" | "chain" | "asset" | "unknown"; label?: string; size?: number } = $props();
</script>

<span class="mark {kind}" style:width="{size}px" style:height="{size}px" style:font-size="{Math.round(size * 0.36)}px">
  {#if kind === "ecash"}
    <EcashLogo size={Math.round(size * 0.6)} />
  {:else if kind === "unknown"}
    ?
  {:else}
    {label}
  {/if}
</span>

<style>
  .mark {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    border-radius: 50%;
    font-weight: 700;
    line-height: 1;
  }
  /* eCash's mark: its gold on near black, with clear space around it, in both themes. */
  .ecash {
    background: #0a0a0c;
  }
  .chain {
    background: var(--sidechain);
    color: var(--on-sidechain);
  }
  .asset {
    background: var(--accent);
    color: var(--on-accent);
  }
  .unknown {
    background: var(--surface-2);
    color: var(--muted);
  }
</style>
