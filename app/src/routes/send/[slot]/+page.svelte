<script lang="ts">
  import { page } from "$app/state";
  import { reportedState, startSend, type SendResult, type SlotReport } from "$lib/background";

  const slot = Number(page.params.slot);
  let report = $state<SlotReport | undefined>(undefined);
  let loaded = $state(false);
  let asset = $state("");
  let amount = $state("");
  let destination = $state("");
  let busy = $state(false);
  let done = $state<SendResult | undefined>(undefined);
  let error = $state("");

  // The assets to send are the ones the Sidechain Server reports a balance of.
  reportedState(slot).then(
    (r) => {
      report = r;
      asset = r.balances[0]?.asset ?? "";
      loaded = true;
    },
    (e) => {
      error = (e as Error).message;
      loaded = true;
    },
  );

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    error = "";
    done = undefined;
    try {
      done = await startSend({ slot, asset, amount: amount.trim(), destination: destination.trim() });
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<main data-screen-ready={loaded ? "" : undefined}>
  <h1>Send on Slot {slot}</h1>

  {#if report}
    <p class="reported">
      The Sidechain Server at <strong data-server>{report.server}</strong> builds the transaction. You review
      exactly what it built, decoded by this wallet, before anything is signed.
    </p>
    <form onsubmit={submit}>
      <label>
        Asset
        <select bind:value={asset} data-send-asset>
          {#each report.balances as balance (balance.asset)}
            <option value={balance.asset}>{balance.asset.slice(0, 8)}… ({balance.amount} reported)</option>
          {/each}
        </select>
      </label>
      <label>
        Amount (base units)
        <input inputmode="numeric" bind:value={amount} data-send-amount />
      </label>
      <label>
        Destination address
        <input bind:value={destination} autocomplete="off" spellcheck="false" data-send-destination />
      </label>
      <button type="submit" disabled={busy || !asset} data-send-submit>Review and send</button>
    </form>
    {#if busy}<p data-send-waiting>Waiting for the Sidechain Server and your approval…</p>{/if}
  {/if}

  {#if done}
    <p class="done" role="status" data-send-done>
      Signed and submitted to {done.server}{done.accepted ? "" : ", which didn't accept it"}.
      {#if done.txid}Transaction <code>{done.txid}</code>.{/if}
    </p>
  {/if}
  {#if error}<p class="error" role="alert" data-error>{error}</p>{/if}

  <nav><a href="#/">Back to your account</a></nav>
</main>

<style>
  main {
    font-family: system-ui, sans-serif;
    padding: 1rem;
    max-width: 30rem;
  }
  label {
    display: block;
    margin-bottom: 0.5rem;
  }
  input,
  select {
    display: block;
    width: 100%;
  }
  .reported {
    font-style: italic;
    color: #555;
    word-break: break-all;
  }
  .done {
    color: #1b5e20;
    word-break: break-all;
  }
  .error {
    color: #b00020;
  }
</style>
