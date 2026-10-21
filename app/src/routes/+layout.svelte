<script lang="ts">
  import "../app.css";
  import { reportActivity } from "$lib/activity";

  let { children } = $props();

  $effect(reportActivity);
</script>

{@render children()}
