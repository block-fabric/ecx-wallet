<script lang="ts">
  import { page } from "$app/state";
  import {
    getApproval,
    resolveApproval,
    unlockApproval,
    type ApprovalPrompt,
    type AssetAmount,
    type ClearView,
    type DangerousMode,
  } from "$lib/background";

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

  const SIGHASH_NAMES: Record<number, string> = {
    0x02: "NONE",
    0x03: "SINGLE",
    0x81: "ALL|ANYONECANPAY",
    0x82: "NONE|ANYONECANPAY",
    0x83: "SINGLE|ANYONECANPAY",
  };

  /** A dangerous mode, in words. The Chain Module reports it as data; the words are the app's. */
  function describe(mode: DangerousMode, view: ClearView): string {
    if (mode.kind === "nonDefaultSighash") {
      const name = SIGHASH_NAMES[mode.sighash] ?? "non-standard";
      return (
        `Input ${mode.input} is signed with sighash ${name} (0x${mode.sighash.toString(16)}), not the default ALL: ` +
        "your signature won't cover the whole transaction, so others could change parts of it after you sign."
      );
    }
    const output = view.outputs.find((o) => o.index === mode.output);
    const burn = output ? amount(output) : "funds";
    const payout =
      output?.destination.kind === "withdrawal"
        ? ` If the withdrawal is accepted, ${output.destination.payout} is paid on L1 (after a ${output.destination.parentFee} parent fee).`
        : "";
    return (
      `Output ${mode.output} is a withdrawal burn of ${burn}: it is irreversible. The burned funds leave this sidechain at once, ` +
      `but the L1 withdrawal takes months (the BIP300 miner vote runs about 3 to 6 months), and acceptance doesn't guarantee payment.${payout}`
    );
  }

  /** Requester labels for outputs the Clear View doesn't have (shown, tagged, but attached to nothing). */
  function strayLabels(view: ClearView, labels: Record<string, string> | undefined): [string, string][] {
    const indexes = new Set(view.outputs.map((o) => String(o.index)));
    return Object.entries(labels ?? {}).filter(([k]) => !indexes.has(k));
  }
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
{:else if prompt.kind === "sign" && prompt.decoded.kind === "clear"}
  {@const view = prompt.decoded.view}
  {@const labels = prompt.hints?.outputLabels ?? {}}
  <main data-approval-ready data-clear-view>
    {#if view.dangerousModes.length > 0}
      <section class="danger" role="alert">
        <h2>Dangerous</h2>
        <ul>
          {#each view.dangerousModes as mode, i (i)}<li data-dangerous-mode>{describe(mode, view)}</li>{/each}
        </ul>
      </section>
    {/if}

    <h1>Signing request</h1>
    <p>From <strong data-origin>{prompt.origin}</strong> on <code data-chain>{prompt.chain}</code></p>

    <h2>Outputs</h2>
    <ol class="rows">
      {#each view.outputs as output (output.index)}
        <li data-output>
          <div class="amount">{amount(output)}</div>
          {#if output.destination.kind === "address"}
            <div>to <code data-destination>{output.destination.address}</code></div>
            {#if output.destination.yours}
              <div class="yours" data-yours>Yours (verified by this wallet)</div>
            {:else}
              <div class="not-yours" data-not-yours>Not yours</div>
            {/if}
          {:else}
            <div>
              {#if output.destination.l1Address !== undefined}
                Withdrawal burn to L1 address <code data-destination>{output.destination.l1Address}</code>,
              {:else}
                Withdrawal burn to a non-standard L1 script (hex) <code data-destination>{output.destination.l1ScriptPubkey}</code>,
              {/if}
              paying {output.destination.payout} after a {output.destination.parentFee} parent fee
            </div>
            <div class="not-yours" data-not-yours>Not yours: burned</div>
          {/if}
          {#if labels[String(output.index)] !== undefined}
            <div class="reported" data-hint-label>Reported by {prompt.origin}: {labels[String(output.index)]}</div>
          {/if}
        </li>
      {/each}
    </ol>

    <dl>
      <dt>Fee</dt>
      <dd data-fee>{amount(view.fee)}</dd>
      <dt>Inputs</dt>
      <dd>
        {#each view.inputs as input (input.index)}
          <div data-input>Input {input.index}: {amount(input)} {input.yours ? "(yours: you sign it)" : "(not yours)"}</div>
        {/each}
      </dd>
    </dl>

    {#if prompt.hints?.summary}
      <p class="reported" data-hint-summary>Reported by {prompt.origin}: {prompt.hints.summary}</p>
    {/if}
    {#each strayLabels(view, prompt.hints?.outputLabels) as [key, label] (key)}
      <p class="reported" data-hint-stray-label>Reported by {prompt.origin}: output {key}: {label}</p>
    {/each}

    <div class="actions">
      <button data-reject disabled={busy} onclick={() => decide(false)}>Reject</button>
      <button data-approve disabled={busy} onclick={() => decide(true)}>Sign</button>
    </div>
  </main>
{:else if prompt.kind === "sign" && prompt.decoded.kind === "blind"}
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
    {#each Object.entries(prompt.hints?.outputLabels ?? {}) as [key, label] (key)}
      <p class="reported" data-hint-stray-label>Reported by {prompt.origin}: output {key}: {label}</p>
    {/each}

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
  .rows li {
    margin-bottom: 0.5rem;
    word-break: break-all;
  }
  .amount {
    font-weight: bold;
  }
  .yours {
    color: #1b5e20;
  }
  .not-yours {
    color: #555;
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
