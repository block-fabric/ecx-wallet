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
  import { shortAsset } from "$lib/asset";
  import Icon from "$lib/Icon.svelte";

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

  const amount = (a: AssetAmount) => `${a.amount} (asset ${shortAsset(a.asset)})`;

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

{#snippet requester(origin: string, chain?: string)}
  <div class="card requester">
    <span class="muted small">Requested by</span>
    <strong class="origin" data-origin>{origin}</strong>
    {#if chain}<span class="chain">on <code class="chip" data-chain>{chain}</code></span>{/if}
  </div>
{/snippet}

{#if prompt === undefined}
  <main class="screen">
    <p class="loading"><span class="spinner"></span>Loading…</p>
  </main>
{:else if prompt === null}
  <main class="screen" data-approval-ready data-approval-missing>
    <div class="card centered">
      <h1>Request no longer pending</h1>
      <p class="muted">This request was already answered or has expired. You can close this window.</p>
    </div>
  </main>
{:else if prompt.kind === "connect"}
  <main class="screen" data-approval-ready>
    <div class="title">
      <h1>Grant request</h1>
      <p class="muted small">This site asks for a Grant to use your wallet:</p>
    </div>
    {@render requester(prompt.origin)}

    <section class="card">
      <h2>Sidechains (Slots)</h2>
      <ul class="chips">
        {#each prompt.slots as slot (slot)}
          <li class="chip" data-slot>{slot}</li>
        {/each}
      </ul>
      <h2>It will be allowed to ask for</h2>
      <ul class="chips">
        {#each prompt.methods as method (method)}
          <li class="chip" data-method>{method}</li>
        {/each}
      </ul>
    </section>

    <p class="notice"><Icon name="shield" /><span>It will not be able to sign anything without asking you each time.</span></p>

    <label class="opt-in" class:on={blindOptIn}>
      <input type="checkbox" bind:checked={blindOptIn} data-blind-opt-in />
      <span>
        Also allow <strong>Blind Signing</strong>: asking you to sign requests the wallet can't explain.
        Leave this off unless you trust this site completely.
      </span>
    </label>

    <div class="decision">
      <button data-reject disabled={busy} onclick={() => decide(false)}>Reject</button>
      <button class={blindOptIn ? "danger-button" : "primary"} data-approve disabled={busy} onclick={() => decide(true)}>
        Approve Grant
      </button>
    </div>
  </main>
{:else if prompt.kind === "unlock"}
  <main class="screen" data-approval-ready data-unlock-required>
    <div class="title">
      <h1>Unlock to review a request</h1>
      <p class="muted small">This site sent a Signing Request. Unlock your wallet to see it. Nothing is signed until you approve it.</p>
    </div>
    {@render requester(prompt.origin, prompt.chain)}
    <form class="card" onsubmit={unlock}>
      <label>
        Password
        <input type="password" autocomplete="current-password" bind:value={password} data-password />
      </label>
      <button class="primary block" type="submit" disabled={busy} data-unlock><Icon name="lock" size={16} /> Unlock</button>
    </form>
    {#if error}<p class="error" role="alert" data-error>{error}</p>{/if}
  </main>
{:else if prompt.kind === "sign" && prompt.decoded.kind === "clear"}
  {@const view = prompt.decoded.view}
  {@const labels = prompt.hints?.outputLabels ?? {}}
  {@const dangerous = view.dangerousModes.length > 0}
  <main class="screen" data-approval-ready data-clear-view>
    {#if dangerous}
      <section class="danger-box" role="alert">
        <h2><Icon name="warning" /> Dangerous</h2>
        <ul class="stack">
          {#each view.dangerousModes as mode, i (i)}<li data-dangerous-mode>{describe(mode, view)}</li>{/each}
        </ul>
      </section>
    {/if}

    <div class="title">
      <h1>Signing Request</h1>
      <span class="badge ok"><Icon name="check" size={14} /> Clear View: decoded by this wallet</span>
    </div>
    {@render requester(prompt.origin, prompt.chain)}

    <section class="stack">
      <h2>Outputs</h2>
      <ol class="stack">
        {#each view.outputs as output (output.index)}
          <li class="card output" data-output>
            <div class="output-head">
              <span class="amount">{output.amount}</span>
              <span class="muted small">asset <code title={output.asset}>{shortAsset(output.asset)}</code></span>
              <span class="index muted small">Output {output.index}</span>
            </div>
            {#if output.destination.kind === "address"}
              <div class="small">to <code data-destination>{output.destination.address}</code></div>
              {#if output.destination.yours}
                <span class="badge ok" data-yours><Icon name="check" size={14} /> Yours (verified by this wallet)</span>
              {:else}
                <span class="badge" data-not-yours>Not yours</span>
              {/if}
            {:else}
              <div class="small">
                {#if output.destination.l1Address !== undefined}
                  Withdrawal burn to L1 address <code data-destination>{output.destination.l1Address}</code>,
                {:else}
                  Withdrawal burn to a non-standard L1 script (hex) <code data-destination>{output.destination.l1ScriptPubkey}</code>,
                {/if}
                paying {output.destination.payout} after a {output.destination.parentFee} parent fee
              </div>
              <span class="badge bad" data-not-yours>Not yours: burned</span>
            {/if}
            {#if labels[String(output.index)] !== undefined}
              <p class="reported" data-hint-label>Reported by {prompt.origin}: {labels[String(output.index)]}</p>
            {/if}
          </li>
        {/each}
      </ol>
    </section>

    <dl class="card facts">
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

    <div class="decision">
      <button data-reject disabled={busy} onclick={() => decide(false)}>Reject</button>
      <button class={dangerous ? "danger-button" : "primary"} data-approve disabled={busy} onclick={() => decide(true)}>Sign</button>
    </div>
  </main>
{:else if prompt.kind === "sign" && prompt.decoded.kind === "blind"}
  {@const facts = prompt.decoded.verifiableFacts}
  <main class="screen" data-approval-ready data-blind>
    <div class="blind-banner" role="alert">
      <h1><Icon name="eye_off" size={24} /> Blind Signing</h1>
      <p>The wallet <strong>can't show you what this request does.</strong> {prompt.decoded.reason}</p>
      <p>Only approve if you trust this site completely and expected this request.</p>
    </div>

    {#if facts.dangerousFlags.length > 0}
      <section class="danger-box">
        <h2><Icon name="warning" /> Dangerous</h2>
        <ul class="stack">
          {#each facts.dangerousFlags as flag (flag)}<li data-dangerous-flag>{flag}</li>{/each}
        </ul>
      </section>
    {/if}

    {@render requester(prompt.origin, prompt.chain)}

    <section class="stack">
      <h2>What the wallet can prove</h2>
      <dl class="card facts">
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
            <ul>{#each facts.unknownFields as field (field)}<li data-unknown-field><code>{field}</code></li>{/each}</ul>
          </dd>
        {/if}
      </dl>
    </section>

    {#if prompt.hints?.summary}
      <p class="reported" data-hint-summary>Reported by {prompt.origin}: {prompt.hints.summary}</p>
    {/if}
    {#each Object.entries(prompt.hints?.outputLabels ?? {}) as [key, label] (key)}
      <p class="reported" data-hint-stray-label>Reported by {prompt.origin}: output {key}: {label}</p>
    {/each}

    <div class="decision">
      <button data-reject disabled={busy} onclick={() => decide(false)}>Reject</button>
      <button class="danger-button" data-approve disabled={busy} onclick={() => decide(true)}>Sign blindly</button>
    </div>
  </main>
{/if}

<style>
  .title {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
  }
  .centered {
    align-items: center;
    text-align: center;
  }
  .requester {
    gap: 4px;
  }
  .chain {
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 600;
  }
  .chain .chip {
    font-size: 0.9rem;
    font-weight: 700;
    color: var(--text);
  }
  .opt-in {
    flex-direction: row;
    gap: 10px;
    padding: 12px;
    border: 1px solid var(--danger-border);
    border-radius: var(--radius-sm);
    font-weight: 400;
  }
  .opt-in.on {
    border: 2px solid var(--danger);
    background: var(--danger-bg);
  }
  .blind-banner {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: -16px -16px 0;
    padding: 20px 16px;
    background: var(--danger-solid);
    color: var(--on-danger);
  }
  .blind-banner h1 {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 1.5rem;
  }
  .output {
    gap: 8px;
  }
  .output-head {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 4px 8px;
  }
  .amount {
    font-size: 1.25rem;
  }
  .index {
    margin-left: auto;
  }
  .facts {
    gap: 2px;
    font-size: 0.9rem;
  }
  .facts dt {
    color: var(--muted);
    font-size: 0.8rem;
  }
  .facts dt:not(:first-child) {
    margin-top: 10px;
  }
  .facts dd {
    overflow-wrap: anywhere;
  }
</style>
