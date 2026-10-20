<script lang="ts">
  import { page } from "$app/state";
  import { l1Reported, startDeposit, type ChainReport } from "$lib/background";
  import Icon from "$lib/Icon.svelte";
  import TopBar from "$lib/TopBar.svelte";

  const slot = Number(page.params.slot);
  let report = $state<ChainReport | undefined>(undefined);
  let loaded = $state(false);
  let amount = $state("");
  let busy = $state(false);
  let done = $state<{ txid: string; server: string } | undefined>(undefined);
  let error = $state("");

  /** The confirmed sats eCash's server reports: the only coins a Deposit spends. */
  const available = $derived(report?.balances.find((b) => b.asset === "")?.amount ?? "0");

  l1Reported().then(
    (r) => {
      report = r;
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
      done = await startDeposit({ slot, amount: amount.trim() });
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<main class="screen" data-screen-ready={loaded ? "" : undefined}>
  <TopBar title="Deposit to Slot {slot}" back="#/" />

  {#if !loaded}
    <p class="loading"><span class="spinner"></span>Loading…</p>
  {/if}

  {#if report}
    <div class="card">
      <span class="muted small">Available on eCash (confirmed)</span>
      <strong class="amount" data-deposit-available>{available} sats</strong>
      <p class="reported">Reported by {report.server}. This wallet doesn't verify it.</p>
    </div>
  {/if}

  {#if loaded}
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
    {#if busy}<p class="loading small" data-deposit-waiting><span class="spinner"></span>Building the deposit and waiting for your approval…</p>{/if}
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
