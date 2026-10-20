<script lang="ts">
  import { page } from "$app/state";
  import { l1Cached, l1Reported, showReport, startDeposit, type ChainReport, type ShownReport } from "$lib/background";
  import Icon from "$lib/Icon.svelte";
  import TopBar from "$lib/TopBar.svelte";

  const slot = Number(page.params.slot);
  /** What eCash's server reports (this session's last report while scanning), or why it couldn't be read. */
  let shown = $state<ShownReport>({ refreshing: true });
  let amount = $state("");
  let busy = $state(false);
  let done = $state<{ txid: string; server: string } | undefined>(undefined);
  let error = $state("");

  /** The confirmed sats eCash's server reports: the only coins a Deposit spends. */
  const available = (report: ChainReport) => report.balances.find((b) => b.asset === "")?.amount ?? "0";
  const readAt = (report: ChainReport) => new Date(report.readAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  // Only shown to help pick an amount: the Deposit scans the coins again itself, so the form
  // doesn't wait for this (the server can take tens of seconds over 40 addresses).
  showReport(l1Cached, l1Reported, (s) => (shown = s));

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
    {#if shown.report}
      <strong class="amount" data-deposit-available>{available(shown.report)} sats</strong>
      <p class="reported">Reported by {shown.report.server}. This wallet doesn't verify it.</p>
    {/if}
    {#if shown.refreshing}
      <p class="loading small" data-deposit-scanning>
        <span class="spinner"></span>
        {shown.report
          ? `Last read at ${readAt(shown.report)}; scanning your eCash addresses again…`
          : "Scanning your eCash addresses for confirmed coins…"}
      </p>
    {:else if shown.error !== undefined}
      <p class="error small" data-balance-error>
        {shown.report ? `Couldn't refresh (showing ${readAt(shown.report)}'s)` : "Balance unavailable"}: {shown.error}
      </p>
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
