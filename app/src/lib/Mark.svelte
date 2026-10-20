<script lang="ts">
  /** The wallet's mark. */
  let { size = 28 }: { size?: number } = $props();
</script>

<svg width={size} height={size} viewBox="0 0 28 28" aria-hidden="true">
  <rect width="28" height="28" rx="8" fill="var(--accent)" />
  <path d="M9 8h10M9 14h8M9 20h10M9 8v12" stroke="var(--on-accent)" stroke-width="2.4" stroke-linecap="round" />
</svg>

<style>
  svg {
    display: block;
    flex: none;
  }
</style>
