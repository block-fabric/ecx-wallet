<script lang="ts">
  import { listGrants, revokeGrant, type Grant } from "$lib/background";
  import TopBar from "$lib/TopBar.svelte";

  let grants = $state<Grant[] | undefined>(undefined);

  let revoking = $state<string | undefined>(undefined);

  function load() {
    return listGrants().then(
      (g) => (grants = g),
      () => (grants = []),
    );
  }
  load();

  async function revoke(origin: string) {
    revoking = origin;
    try {
      await revokeGrant(origin);
    } finally {
      await load();
      revoking = undefined;
    }
  }
</script>

<main class="screen" data-screen-ready={grants !== undefined ? "" : undefined}>
  <TopBar title="Grants" back="#/settings" />
  <p class="muted small">Each site below holds a Grant: it may ask for the listed methods on the listed sidechains.</p>

  {#if grants === undefined}
    <p class="loading"><span class="spinner"></span>Loading…</p>
  {:else if grants.length === 0}
    <p class="notice" data-no-grants>No site holds a Grant.</p>
  {:else}
    <ul class="stack">
      {#each grants as grant (grant.origin)}
        <li class="card" data-grant data-grant-origin={grant.origin}>
          <p class="origin"><strong data-origin>{grant.origin}</strong></p>
          <dl>
            <dt>Sidechains (Slots)</dt>
            <dd class="chips">
              {#each grant.slots as slot (slot)}<span class="chip" data-slot>{slot}</span>{/each}
            </dd>
            <dt>Allowed to ask for</dt>
            <dd class="chips">
              {#each grant.methods as method (method)}<span class="chip" data-method>{method}</span>{/each}
            </dd>
            <dt>Blind Signing</dt>
            <dd>
              <span class="badge" class:bad={grant.blindSigning} data-blind-signing>{grant.blindSigning ? "On" : "Off"}</span>
            </dd>
          </dl>
          <button class="small-button revoke" data-revoke disabled={revoking !== undefined} onclick={() => revoke(grant.origin)}>
            Revoke
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</main>

<style>
  dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 8px 12px;
    align-items: center;
  }
  dt {
    color: var(--muted);
    font-size: 0.8rem;
  }
  .revoke {
    align-self: flex-end;
    color: var(--danger);
    border-color: var(--danger-border);
  }
</style>
