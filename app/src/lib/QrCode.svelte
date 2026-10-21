<script lang="ts">
  import { qrMatrix } from "@ecx/wallet";

  /** `text` as a QR code: dark on white in both themes, with the quiet zone scanners need. */
  let { text, size = 176 }: { text: string; size?: number } = $props();

  const QUIET = 4;
  const matrix = $derived(qrMatrix(text));
  const span = $derived(matrix.length + 2 * QUIET);
  /** One path of unit squares, one per dark module. */
  const path = $derived(
    matrix.flatMap((row, y) => row.flatMap((dark, x) => (dark ? [`M${x + QUIET} ${y + QUIET}h1v1h-1z`] : []))).join(""),
  );
</script>

<svg width={size} height={size} viewBox="0 0 {span} {span}" shape-rendering="crispEdges" role="img" aria-label="QR code of {text}" data-qr={text}>
  <rect width={span} height={span} fill="#fff" />
  <path d={path} fill="#000" />
</svg>

<style>
  svg {
    display: block;
    border-radius: var(--radius-sm);
  }
</style>
