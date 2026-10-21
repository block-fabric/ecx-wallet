<script lang="ts">
  /** PROTOTYPE, throw away: the floating bar that flips between UI variants. Dev builds only. */
  import type { Snippet } from "svelte";
  import { dev } from "$app/environment";

  let {
    variants,
    current,
    onchange,
    extra,
  }: { variants: { key: string; name: string }[]; current: string; onchange: (key: string) => void; extra?: Snippet } = $props();

  const index = $derived(Math.max(0, variants.findIndex((v) => v.key === current)));
  const step = (by: number) => onchange(variants[(index + by + variants.length) % variants.length].key);

  function onkeydown(e: KeyboardEvent) {
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable]")) return;
    if (e.key === "ArrowLeft") step(-1);
    if (e.key === "ArrowRight") step(1);
  }
</script>

<svelte:window {onkeydown} />

{#if dev}
  <div class="switcher" role="toolbar" aria-label="Prototype variants">
    <button onclick={() => step(-1)} aria-label="Previous variant">←</button>
    <span class="label"><strong>{variants[index].key}</strong> ({variants[index].name})</span>
    <button onclick={() => step(1)} aria-label="Next variant">→</button>
    {#if extra}<span class="divider"></span>{@render extra()}{/if}
  </div>
{/if}

<style>
  .switcher {
    position: fixed;
    bottom: 16px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 1000;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border-radius: 999px;
    background: #111;
    color: #fff;
    font: 600 13px/1 system-ui, sans-serif;
    box-shadow: 0 6px 24px rgb(0 0 0 / 35%);
    white-space: nowrap;
  }
  .switcher :global(button) {
    min-height: 28px;
    padding: 0 10px;
    border: none;
    border-radius: 999px;
    background: #333;
    color: #fff;
    font: inherit;
  }
  .switcher :global(button:hover) {
    background: #555;
  }
  .label {
    min-width: 170px;
    text-align: center;
  }
  .divider {
    width: 1px;
    height: 18px;
    background: #444;
  }
</style>
