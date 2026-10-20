<script lang="ts">
  import { page } from "$app/state";
  import { l1Reported, startDeposit, type ChainReport } from "$lib/background";
  import Icon from "$lib/Icon.svelte";
  import TopBar from "$lib/TopBar.svelte";

  const slot = Number(page.params.slot);
  /** What eCash's server reports, or why it couldn't be read; undefined while scanning. */
  let report = $state<ChainReport | { error: string } | undefined>(undefined);
  let amount = $state("");
  let busy = $state(false);
  let done = $state<{ txid: string; server: string } | undefined>(undefined);
  let error = $state("");

  /** The confirmed sats eCash's server reports: the only coins a Deposit spends. */
  const available = $derived(report !== undefined && !("error" in report) ? (report.balances.find((b) => b.asset === "")?.amount ?? "0") : undefined);

  // Only shown to help pick an amount: the Deposit scans the coins again itself, so the form
  // doesn't wait for this (the server can take tens of seconds over 40 addresses).
  l1Reported().then(
    (r) => (report = r),
    (e) => (report = { error: (e as Error).message }),
  );

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    error = "";
    done = undefined;
    try {
      done = await startDeposit({ slot, amount: amount.trim() });
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<main class="screen" data-screen-ready>
  <TopBar title="Deposit to Slot {slot}" back="#/" />

  <div class="card">
    <span class="muted small">Available on eCash (confirmed)</span>
    {#if report === undefined}
      <p class="loading small" data-deposit-scanning>
        <span class="spinner"></span>Scanning your eCash addresses for confirmed coins…
      </p>
    {:else if "error" in report}
      <p class="error small" data-balance-error>Balance unavailable: {report.error}</p>
    {:else}
      <strong class="amount" data-deposit-available>{available} sats</strong>
      <p class="reported">Reported by {report.server}. This wallet doesn't verify it.</p>
    {/if}
  </div>

  <form class="stack" onsubmit={submit}>
    <div class="card">
      <label>
        Amount (sats)
        <input inputmode="numeric" bind:value={amount} autocomplete="off" data-deposit-amount />
      </label>
    </div>
    <p class="notice">
      <Icon name="warning" />
      <span>
        A Deposit moves eCash into Slot {slot}. It is credited to your own address there after 100 eCash blocks, once
        the chain's operator imports it. It only comes back to eCash through a Withdrawal, which takes months.
      </span>
    </p>
    <p class="reported">
      This wallet builds the transaction from your own coins. You review exactly what it built before anything is signed.
    </p>
    <button class="primary block" type="submit" disabled={busy || amount.trim() === ""} data-deposit-submit>Review deposit</button>
  </form>
  {#if busy}
    <p class="loading small" data-deposit-waiting>
      <span class="spinner"></span>Scanning your eCash coins and building the deposit, then waiting for your approval…
    </p>
  {/if}

  {#if done}
    <p class="success" role="status" data-deposit-done>
      Deposit broadcast through {done.server}. Transaction <code data-deposit-txid>{done.txid}</code>. Its progress shows on
      the home page.
    </p>
  {/if}
  {#if error}<p class="error" role="alert" data-error>{error}</p>{/if}
</main>

<style>
  .amount {
    font-size: 1.6rem;
  }
</style>
