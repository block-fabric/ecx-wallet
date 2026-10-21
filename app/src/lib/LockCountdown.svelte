<script lang="ts">
  import { onLockDeadline } from "$lib/background";

  /**
   * "Locks in 15 min", counting down to the auto-lock deadline and following it as it moves (any
   * use moves it). `onlocked` runs once it passes or the background says the wallet locked.
   */
  let { locksAt, onlocked }: { locksAt: number | undefined; onlocked: () => void } = $props();

  // Follows the prop until the background announces a newer deadline.
  let announced = $state<number | null | undefined>(undefined);
  let now = $state(Date.now());
  const deadline = $derived(announced === undefined ? locksAt : announced);
  const left = $derived(deadline === undefined || deadline === null ? undefined : deadline - now);

  $effect(() =>
    onLockDeadline((next) => {
      announced = next;
      now = Date.now();
    }),
  );
  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });
  $effect(() => {
    if (announced === null || (left !== undefined && left <= 0)) onlocked();
  });
</script>

{#if left !== undefined && left > 0}
  <span class="countdown" title="The wallet locks itself after this long without use" data-lock-countdown>
    <span class="dot"></span>Locks in {left >= 60_000 ? `${Math.round(left / 60_000)} min` : `${Math.ceil(left / 1000)} s`}
  </span>
{/if}

<style>
  .countdown {
    display: flex;
    align-items: center;
    gap: 5px;
    color: var(--muted);
    font-size: 0.7rem;
    white-space: nowrap;
  }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--ok);
    flex: none;
  }
</style>
