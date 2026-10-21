<script lang="ts">
  /** Stroke icons, drawn inline: extension pages load no icon fonts or remote images. */
  const PATHS = {
    lock: "M6 11h12v10H6zM8.5 11V7.5a3.5 3.5 0 0 1 7 0V11",
    warning: "M12 3 2 21h20L12 3zM12 10v5M12 18v.01",
    check: "M5 12.5 10 17l9-10",
    back: "M15 5l-7 7 7 7",
    forward: "M9 5l7 7-7 7",
    shield: "M12 3 4.5 6v6c0 4.5 3.2 7.8 7.5 9 4.3-1.2 7.5-4.5 7.5-9V6L12 3z",
    send: "M5 12h13M13 6l6 6-6 6",
    deposit: "M12 4v11M7 10l5 5 5-5M5 20h14",
    eye_off: "M3 3l18 18M10.6 6.1A9.8 9.8 0 0 1 12 6c5 0 8.5 4 9.5 6a12.7 12.7 0 0 1-2.9 3.6M6.4 7.4A12.6 12.6 0 0 0 2.5 12c1 2 4.5 6 9.5 6a9.5 9.5 0 0 0 4.3-1M9.9 9.9a3 3 0 0 0 4.2 4.2",
  } as const;

  let { name, size = 18 }: { name: keyof typeof PATHS; size?: number } = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  <path d={PATHS[name]} />
</svg>

<style>
  svg {
    flex: none;
  }
</style>
