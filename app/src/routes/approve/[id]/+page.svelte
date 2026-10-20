<script lang="ts">
  import { page } from "$app/state";
  import { getApproval, resolveApproval, type ConnectPrompt } from "$lib/background";

  const id = page.params.id ?? "";
  let prompt = $state<ConnectPrompt | null | undefined>(undefined);
  let busy = $state(false);

  getApproval(id).then(
    (p) => (prompt = p),
    () => (prompt = null),
  );

  async function decide(approved: boolean) {
    busy = true;
    // The background closes this window once it has recorded the decision.
    await resolveApproval(id, approved);
  }
</script>

{#if prompt === undefined}
  <p>Loading…</p>
{:else if prompt === null}
  <main data-approval-ready data-approval-missing>
    <h1>Request no longer pending</h1>
    <p>This request was already answered or has expired. You can close this window.</p>
  </main>
{:else}
  <main data-approval-ready>
    <h1>Connection request</h1>
    <p>This site wants to connect to your wallet:</p>
    <p class="origin"><strong data-origin>{prompt.origin}</strong></p>

    <h2>Sidechains (Slots)</h2>
    <ul>
      {#each prompt.slots as slot (slot)}
        <li data-slot>{slot}</li>
      {/each}
    </ul>

    <h2>It will be allowed to ask for</h2>
    <ul>
      {#each prompt.methods as method (method)}
        <li data-method>{method}</li>
      {/each}
    </ul>

    <p>It will not be able to sign anything without asking you each time.</p>

    <div class="actions">
      <button data-reject disabled={busy} onclick={() => decide(false)}>Reject</button>
      <button data-approve disabled={busy} onclick={() => decide(true)}>Connect</button>
    </div>
  </main>
{/if}

<style>
  main {
    font-family: system-ui, sans-serif;
    padding: 1rem;
  }
  .origin {
    font-size: 1.1rem;
    word-break: break-all;
  }
  .actions {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
  }
</style>
