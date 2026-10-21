<script lang="ts">
  /** PROTOTYPE, throw away: the real icon set plus the few more the variants need. */
  const PATHS = {
    lock: "M6 11h12v10H6zM8.5 11V7.5a3.5 3.5 0 0 1 7 0V11",
    warning: "M12 3 2 21h20L12 3zM12 10v5M12 18v.01",
    back: "M15 5l-7 7 7 7",
    forward: "M9 5l7 7-7 7",
    shield: "M12 3 4.5 6v6c0 4.5 3.2 7.8 7.5 9 4.3-1.2 7.5-4.5 7.5-9V6L12 3z",
    copy: "M9 9h11v11H9zM5 15H4V4h11v1",
    check: "M5 12.5 10 17l9-10",
    close: "M6 6l12 12M18 6 6 18",
    send: "M12 19V5M6 11l6-6 6 6",
    receive: "M12 5v14M6 13l6 6 6-6",
    deposit: "M4 7h11M11 3l4 4-4 4M20 17H9M13 13l-4 4 4 4",
    self: "M4 12a8 8 0 0 1 14-5.3M20 4v4h-4M20 12a8 8 0 0 1-14 5.3M4 20v-4h4",
    history: "M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM12 7v5l3 2",
    chevron: "M6 9l6 6 6-6",
    more: "M12 5v.01M12 12v.01M12 19v.01",
    wallet: "M3 7h15a3 3 0 0 1 3 3v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7zM3 7l2-3h11M16 13.5h.01",
    activity: "M3 12h4l3-8 4 16 3-8h4",
    grants: "M10 14a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2.5 21a7.5 7.5 0 0 1 15 0M17 4l1.5 1.5L21.5 2.5",
    qr: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 18h2v2h-2zM14 18h2v2h-2zM18 14h2v2h-2z",
    refresh: "M20 11a8 8 0 0 0-14.6-4.4M4 4v3h3M4 13a8 8 0 0 0 14.6 4.4M20 20v-3h-3",
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
