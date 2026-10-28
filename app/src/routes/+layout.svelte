<script lang="ts">
  import "../app.css";
  import { reportActivity } from "$lib/activity";
  import { vaultStatus } from "$lib/background";
  import BottomBar from "$lib/BottomBar.svelte";
  import { page } from "$app/state";
  import { nav, pathOf } from "$lib/nav.svelte";
  import { currentView } from "$lib/view";

  let { children } = $props();

  $effect(reportActivity);
  // The bottom bar: on every screen of an unlocked wallet, but not in an approval window or while setting one up.
  const path = $derived(pathOf(page.url.hash));
  const barless = $derived(/^\/(approve|create|import)(\/|$)/.test(path));
  // Until the first answer the bar's place isn't known (`data-bar-known`, which the e2e tests wait for).
  let barKnown = $state(false);
  $effect(() => {
    void path;
    vaultStatus().then(
      (s) => ((nav.unlocked = s.unlocked), (barKnown = true)),
      () => (barKnown = true),
    );
  });
  // app.css sizes the page by where it shows.
  $effect(() => {
    document.documentElement.dataset.view = currentView();
  });
</script>

<!-- The screen scrolls in its own area, above the bottom bar: nothing ever sits under the bar. -->
<div class="frame" data-bar-known={barKnown || undefined}>
  <div class="scroll">{@render children()}</div>
  {#if nav.unlocked && !barless}<BottomBar />{/if}
</div>

<style>
  .frame {
    display: flex;
    flex-direction: column;
    height: 100vh;
  }
  /* The toolbar popup is as tall as the browser lets it be (600px). */
  :global(html[data-view="popup"]) .frame {
    height: 600px;
  }
  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
</style>
