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
    { key: "A", name: "B, fresh and addressed" },
    { key: "B", name: "A, unit switch, matching chains" },
    { key: "C", name: "B, folded" },
  ];

  const variant = $derived(VARIANTS.some((v) => v.key === page.params.variant) ? page.params.variant! : "A");
  let scenario = $state<Scenario>("healthy");
  const chains = $derived(chainsFor(scenario));
</script>

{#snippet scenarioToggle()}
  <button onclick={() => (scenario = scenario === "healthy" ? "trouble" : "healthy")} title="Switch the made-up data">
    Data: {scenario === "healthy" ? "all fine" : "eCash down, Elements+ refreshing"}
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
  /* eCash's brand (ecash.com/brand): eCash Gold on its own neutrals; its pink for warnings and lime
     for success. Darker gold, pink and lime carry text on light backgrounds, for contrast. */
  .popup {
    --bg: #f7f7f4;
    --surface: #ffffff;
    --surface-2: #eeeeeb;
    --border: #dadad6;
    --text: #09090b;
    --muted: #52525b;
    --accent: #e8a84a;
    --accent-hover: #d9963a;
    --accent-text: #8a5a0f;
    --on-accent: #0a0a0c;
    --focus: #b87a1e;
    --ok: #4f7a12;
    --ok-bg: #eef6e0;
    --warn: #b4325a;
    --warn-bg: #fbe8ee;
  }
  @media (prefers-color-scheme: dark) {
    .popup {
      --bg: #0a0a0c;
      --surface: #111114;
      --surface-2: #1a1a1e;
      --border: #27272a;
      --text: #fafafa;
      --muted: #a1a1aa;
      --accent: #e8a84a;
      --accent-hover: #f0b965;
      --accent-text: #e8a84a;
      --on-accent: #0a0a0c;
      --focus: #e8a84a;
      --ok: #a8d65a;
      --ok-bg: #1f2b10;
      --warn: #e86a8a;
      --warn-bg: #3a1520;
      --shadow: none;
    }
  }
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
