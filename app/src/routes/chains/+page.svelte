<script lang="ts">
  import ChainSwitches from "$lib/ChainSwitches.svelte";
  import TopBar from "$lib/TopBar.svelte";

  let ready = $state(false);
</script>

<main class="screen" data-screen-ready={ready ? "" : undefined} data-chains>
  <TopBar title="Chains" back="#/" />
  <p class="muted small">Turn on the chains you use. Turning one off only hides it: your funds on it stay where they are.</p>
  <ChainSwitches bind:ready />
</main>
