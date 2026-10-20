<script lang="ts">
  import { page } from "$app/state";
  import { getApproval, resolveApproval, unlockApproval, type ApprovalPrompt, type AssetAmount } from "$lib/background";

  const id = page.params.id ?? "";
  let prompt = $state<ApprovalPrompt | null | undefined>(undefined);
  let busy = $state(false);
  let blindOptIn = $state(false);
  let password = $state("");
  let error = $state("");

  function load() {
    prompt = undefined;
    getApproval(id).then(
      (p) => (prompt = p),
      () => (prompt = null),
    );
  }
  load();

  async function decide(approved: boolean) {
    busy = true;
    await resolveApproval(id, approved, { blindSigning: approved && blindOptIn });
    // The background also closes it; closing here too keeps that from depending on a browser quirk.
    window.close();
  }

  async function unlock(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    error = "";
    try {
      await unlockApproval(id, password);
      load(); // the background now prepares the request itself
    } catch (err) {
      error = (err as Error).message;
    } finally {
      password = "";
      busy = false;
    }
  }

  const short = (asset: string) => `${asset.slice(0, 8)}…`;
  const amount = (a: AssetAmount) => `${a.amount} (asset ${short(a.asset)})`;
</script>

{#if prompt === undefined}
  <p>Loading…</p>
{:else if prompt === null}
  <main data-approval-ready data-approval-missing>
    <h1>Request no longer pending</h1>
    <p>This request was already answered or has expired. You can close this window.</p>
  </main>
{:else if prompt.kind === "connect"}
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

    <label class="opt-in">
      <input type="checkbox" bind:checked={blindOptIn} data-blind-opt-in />
      Also allow <strong>Blind Signing</strong>: asking you to sign requests the wallet can't explain.
      {#if prompt.blindSigning}<em>The site asked for this.</em>{/if}
      Leave this off unless you trust this site completely.
    </label>

    <div class="actions">
      <button data-reject disabled={busy} onclick={() => decide(false)}>Reject</button>
      <button data-approve disabled={busy} onclick={() => decide(true)}>Connect</button>
    </div>
  </main>
{:else if prompt.kind === "unlock"}
  <main data-approval-ready data-unlock-required>
    <h1>Unlock to review a request</h1>
    <p><strong data-origin>{prompt.origin}</strong> sent a signing request for <code data-chain>{prompt.chain}</code>.</p>
    <p>Unlock your wallet to see it. Nothing is signed until you approve it.</p>
    <form onsubmit={unlock}>
      <label>
        Password
        <input type="password" autocomplete="current-password" bind:value={password} data-password />
      </label>
      <button type="submit" disabled={busy} data-unlock>Unlock</button>
    </form>
    {#if error}<p class="error" role="alert" data-error>{error}</p>{/if}
  </main>
{:else if prompt.kind === "sign"}
  {@const facts = prompt.decoded.verifiableFacts}
  <main data-approval-ready data-blind>
    <div class="blind-banner" role="alert">
      <h1>Blind Signing</h1>
      <p>The wallet <strong>can't show you what this request does.</strong> {prompt.decoded.reason}</p>
      <p>Only approve if you trust this site completely and expected this request.</p>
    </div>

    <p>From <strong data-origin>{prompt.origin}</strong> on <code data-chain>{prompt.chain}</code></p>

    {#if facts.dangerousFlags.length > 0}
      <section class="danger">
        <h2>Dangerous</h2>
        <ul>
          {#each facts.dangerousFlags as flag (flag)}<li data-dangerous-flag>{flag}</li>{/each}
        </ul>
      </section>
    {/if}

    <h2>What the wallet can prove</h2>
    <dl>
      <dt>Your inputs it will sign</dt>
      <dd>
        {#each facts.ownedInputs as input (input.index)}
          <div data-owned-input>Input {input.index}: {amount(input)}</div>
        {:else}<div>None</div>{/each}
      </dd>
      <dt>Total leaving your wallet</dt>
      <dd>
        {#each facts.totalLeaving as a (a.asset)}<div data-total-leaving>{amount(a)}</div>{:else}<div>Nothing</div>{/each}
      </dd>
      <dt>Fee</dt>
      <dd>{#each facts.fee as a (a.asset)}<div data-fee>{amount(a)}</div>{:else}<div>None stated</div>{/each}</dd>
      {#if facts.unknownFields.length > 0}
        <dt>Fields the wallet doesn't understand</dt>
        <dd>
          <ul>{#each facts.unknownFields as field (field)}<li data-unknown-field>{field}</li>{/each}</ul>
        </dd>
      {/if}
    </dl>

    {#if prompt.hints?.summary}
      <p class="reported" data-hint-summary>Reported by {prompt.origin}: {prompt.hints.summary}</p>
    {/if}

    <div class="actions">
      <button data-reject disabled={busy} onclick={() => decide(false)}>Reject</button>
      <button data-approve disabled={busy} onclick={() => decide(true)}>Sign blindly</button>
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
  .opt-in {
    display: block;
    margin: 1rem 0;
    padding: 0.5rem;
    border: 1px solid #b00020;
  }
  .blind-banner {
    background: #b00020;
    color: white;
    padding: 0.5rem 1rem;
    margin-bottom: 1rem;
  }
  .danger {
    border: 2px solid #b00020;
    padding: 0 1rem;
  }
  .reported {
    font-style: italic;
    color: #555;
  }
  .error {
    color: #b00020;
  }
  dd {
    margin-left: 1rem;
    word-break: break-all;
  }
  .actions {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
  }
</style>
