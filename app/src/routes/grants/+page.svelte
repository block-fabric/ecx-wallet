<script lang="ts">
  import { listGrants, type Grant } from "$lib/background";

  let grants = $state<Grant[] | undefined>(undefined);

  listGrants().then(
    (g) => (grants = g),
    () => (grants = []),
  );
</script>

<main data-screen-ready={grants !== undefined ? "" : undefined}>
  <h1>Connected sites</h1>
  <p>Each site below holds a Grant: it may ask for the listed methods on the listed sidechains.</p>

  {#if grants === undefined}
    <p>Loading…</p>
  {:else if grants.length === 0}
    <p data-no-grants>No site is connected.</p>
  {:else}
    <ul class="grants">
      {#each grants as grant (grant.origin)}
        <li data-grant>
          <p class="origin"><strong data-origin>{grant.origin}</strong></p>
          <dl>
            <dt>Sidechains (Slots)</dt>
            <dd>
              {#each grant.slots as slot (slot)}<span class="tag" data-slot>{slot}</span>{/each}
            </dd>
            <dt>Allowed to ask for</dt>
            <dd>
              {#each grant.methods as method (method)}<span class="tag" data-method>{method}</span>{/each}
            </dd>
            <dt>Blind Signing</dt>
            <dd data-blind-signing>{grant.blindSigning ? "On" : "Off"}</dd>
          </dl>
        </li>
      {/each}
    </ul>
  {/if}
</main>

<style>
  main {
    font-family: system-ui, sans-serif;
    padding: 1rem;
  }
  .grants {
    list-style: none;
    padding: 0;
  }
  .grants > li {
    border: 1px solid #ccc;
    border-radius: 6px;
    padding: 0.75rem;
    margin-bottom: 0.75rem;
  }
  .origin {
    margin-top: 0;
    word-break: break-all;
  }
  dt {
    font-weight: 600;
  }
  dd {
    margin: 0 0 0.5rem;
  }
  .tag {
    display: inline-block;
    margin-right: 0.4rem;
  }
</style>
