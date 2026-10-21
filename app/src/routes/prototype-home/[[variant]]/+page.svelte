<script lang="ts">
  // PROTOTYPE, throw away. Three home-page variants for the redesign, switchable via the hash route
  // (#/prototype-home/A, /B, /C) and the floating bar. They render made-up data in a frame the size
  // of the toolbar popup (360×600). Run with `pnpm prototype:home`.
  import { page } from "$app/state";
  import PrototypeSwitcher from "$lib/PrototypeSwitcher.svelte";
  import { chainsFor, type Scenario } from "../fixtures";
  import VariantA from "../VariantA.svelte";
  import VariantB from "../VariantB.svelte";
  import VariantC from "../VariantC.svelte";

  const VARIANTS = [
    { key: "A", name: "Assets first" },
    { key: "B", name: "A, grouped, MetaMask tabs" },
    { key: "C", name: "A's look on B's map" },
  ];

  const variant = $derived(VARIANTS.some((v) => v.key === page.params.variant) ? page.params.variant! : "A");
  let scenario = $state<Scenario>("healthy");
  const chains = $derived(chainsFor(scenario));
</script>

{#snippet scenarioToggle()}
  <button onclick={() => (scenario = scenario === "healthy" ? "trouble" : "healthy")} title="Switch the made-up data">
    Data: {scenario === "healthy" ? "all fine" : "eCash down, Slot refreshing"}
  </button>
{/snippet}

<div class="stage">
  <div class="popup">
    <div class="scroll">
      {#key variant}
        {#if variant === "A"}<VariantA {chains} />{/if}
        {#if variant === "B"}<VariantB {chains} />{/if}
        {#if variant === "C"}<VariantC {chains} />{/if}
      {/key}
    </div>
  </div>
</div>

<PrototypeSwitcher variants={VARIANTS} current={variant} onchange={(key) => location.replace(`#/prototype-home/${key}`)} extra={scenarioToggle} />

<style>
  .stage {
    display: flex;
    justify-content: center;
    padding: 24px 16px 96px;
  }
  /* The toolbar popup's size. The transform makes it the containing block for position: fixed,
     so sheets and tab bars pin to the popup as they would to the real popup window. */
  .popup {
    width: 360px;
    height: 600px;
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
    transform: translateZ(0);
    background: var(--bg);
    box-shadow: 0 10px 40px rgb(0 0 0 / 18%);
  }
  .scroll {
    height: 100%;
    overflow-y: auto;
  }
</style>
