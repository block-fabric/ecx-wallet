<script lang="ts">
  /** The wallet's mark: the extension's own icon (extension/icons/icon.svg), a black E on polished gold. */
  let { size = 28 }: { size?: number } = $props();
  // Each mark's gradients get their own ids, so one hidden mark can't blank the others.
  const id = $props.id();
</script>

<svg width={size} height={size} viewBox="0 0 128 128" aria-hidden="true">
  <defs>
    <linearGradient id="{id}-gold" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ffe7a8" />
      <stop offset="0.35" stop-color="#f3bd5c" />
      <stop offset="0.7" stop-color="#e09a38" />
      <stop offset="1" stop-color="#b9761f" />
    </linearGradient>
    <linearGradient id="{id}-gloss" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity="0.55" />
      <stop offset="1" stop-color="#fff" stop-opacity="0" />
    </linearGradient>
    <linearGradient id="{id}-rim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff6d8" />
      <stop offset="1" stop-color="#8f5a14" />
    </linearGradient>
    <linearGradient id="{id}-sheen" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#fff" stop-opacity="0" />
      <stop offset="0.5" stop-color="#fff" stop-opacity="0.45" />
      <stop offset="1" stop-color="#fff" stop-opacity="0" />
    </linearGradient>
    <clipPath id="{id}-tile"><rect x="4" y="4" width="120" height="120" rx="34" /></clipPath>
  </defs>
  <rect x="4" y="4" width="120" height="120" rx="34" fill="url(#{id}-gold)" />
  <g clip-path="url(#{id}-tile)">
    <path d="M4 4h120v52C96 66 40 70 4 60z" fill="url(#{id}-gloss)" />
    <rect x="-20" y="40" width="34" height="200" fill="url(#{id}-sheen)" transform="rotate(-35 64 64) translate(70 -60)" />
  </g>
  <rect x="5.5" y="5.5" width="117" height="117" rx="32.5" fill="none" stroke="url(#{id}-rim)" stroke-width="3" opacity="0.8" />
  <path d="M43 37h42M43 64h34M43 91h42M43 37v54" fill="none" stroke="#0a0a0c" stroke-width="11" stroke-linecap="round" stroke-linejoin="round" />
</svg>

<style>
  svg {
    display: block;
    flex: none;
  }
</style>
