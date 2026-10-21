<script lang="ts">
  import type { Snippet } from "svelte";
  import Icon from "$lib/Icon.svelte";

  /** A panel that slides up over the screen, closed by its × or a tap outside it. */
  let { title, onclose, children, ...rest }: { title: string; onclose: () => void; children: Snippet; [data: `data-${string}`]: unknown } = $props();
</script>

<svelte:window onkeydown={(e) => e.key === "Escape" && onclose()} />

<div class="scrim" role="presentation" onclick={onclose}></div>
<div class="sheet" role="dialog" aria-label={title} {...rest}>
  <div class="head">
    <strong>{title}</strong>
    <button class="close" aria-label="Close" onclick={onclose}><Icon name="close" /></button>
  </div>
  {@render children()}
</div>

<style>
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
    max-width: 440px;
    max-height: 85vh;
    margin: 0 auto;
    padding: 16px;
    overflow-y: auto;
    border-radius: 16px 16px 0 0;
    background: var(--surface);
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .close {
    width: 34px;
    min-height: 34px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: none;
    color: var(--muted);
  }
</style>
