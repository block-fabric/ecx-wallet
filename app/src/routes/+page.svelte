<script lang="ts">
  import {
    cachedState,
    dismissDeposit,
    l1Account,
    l1Cached,
    l1Reported,
    listAccounts,
    listDeposits,
    lockVault,
    reportedState,
    showReport,
    unlockVault,
    vaultStatus,
    type ChainReport,
    type DepositStatus,
    type ShownReport,
    type SlotAccount,
    type VaultStatus,
  } from "$lib/background";
  import { shortAsset } from "$lib/asset";
  import Icon from "$lib/Icon.svelte";
  import Mark from "$lib/Mark.svelte";
  import TopBar from "$lib/TopBar.svelte";

  let status = $state<VaultStatus | undefined>(undefined);
  let accounts = $state<SlotAccount[] | undefined>(undefined);
  /** eCash's own receive address, and what its server reports. */
  let l1Address = $state<{ chain: string; address: string } | undefined>(undefined);
  let l1Report = $state<ShownReport | undefined>(undefined);
  /** Per Slot: what its Sidechain Server reports (the last report while refreshing), or why it couldn't be read. */
  let reports = $state<Record<number, ShownReport>>({});
  /** Per Slot: its pending Deposits, or why their status couldn't be read. */
  let deposits = $state<Record<number, DepositStatus[] | { error: string }>>({});
  let password = $state("");
  let error = $state("");
  let busy = $state(false);

  const vaultState = $derived(
    status === undefined ? undefined : !status.exists ? "onboarding" : status.unlocked ? "unlocked" : "locked",
  );

  vaultStatus().then((s) => (status = s));

  // The account screen: derived in the background whenever the wallet is (or becomes) unlocked.
  $effect(() => {
    if (vaultState !== "unlocked") {
      accounts = undefined;
      l1Address = undefined;
      l1Report = undefined;
      return;
    }
    l1Account().then(
      ({ addresses }) => (l1Address = addresses[0]),
      (e) => (error = (e as Error).message),
    );
    showReport(l1Cached, l1Reported, (shown) => (l1Report = shown));
    listAccounts().then(
      (a) => {
        accounts = a;
        for (const { slot } of a) {
          showReport(() => cachedState(slot), () => reportedState(slot), (shown) => (reports[slot] = shown));
          loadDeposits(slot);
        }
      },
      (e) => (error = (e as Error).message),
    );
  });

  function loadDeposits(slot: number) {
    listDeposits(slot).then(
      (d) => (deposits[slot] = d),
      (e) => (deposits[slot] = { error: (e as Error).message }),
    );
  }

  async function dismiss(slot: number, txid: string) {
    await dismissDeposit(txid).catch((e) => (error = (e as Error).message));
    loadDeposits(slot);
  }

  const readAt = (report: ChainReport) => new Date(report.readAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  /** Where a Deposit stands, in words. */
  function depositState(d: DepositStatus): string {
    switch (d.state) {
      case "confirming":
        return `${d.confirmations} / 100 confirmations on eCash`;
      case "awaitingCredit":
        return `Waiting for the ${d.chainName} chain's operator to credit it (not automatic)`;
      case "credited":
        return `Credited, as reported by ${d.creditServer}`;
      case "notFound":
        return `${d.server} doesn't know this transaction: it may have lost the race for the Treasury, or been dropped`;
      case "unavailable":
        return `Status unavailable: ${d.error}`;
    }
  }

  async function act(action: () => Promise<VaultStatus>) {
    busy = true;
    error = "";
    try {
      status = await action();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      password = "";
      busy = false;
    }
  }
</script>

{#snippet reported(shown: ShownReport | undefined)}
  {@const report = shown?.report}
  {#if shown?.error !== undefined}
    <p class="error" data-balance-error>
      {report ? "Couldn't refresh the balance" : "Balance unavailable"}: {shown.error}
    </p>
  {/if}
  {#if report === undefined}
    {#if shown?.error === undefined}
      <p class="loading small"><span class="spinner"></span>Asking the Sidechain Server for your balance…</p>
    {/if}
  {:else}
    <ul class="balances">
      {#each report.balances as balance (balance.asset)}
        <li data-balance data-asset={balance.asset}>
          <strong class="amount">{balance.amount}</strong>
          {#if balance.asset === ""}
            <span class="muted small">sats</span>
          {:else}
            <span class="muted small">asset <code title={balance.asset}>{shortAsset(balance.asset)}</code></span>
          {/if}
        </li>
      {:else}
        <li class="muted" data-no-balance>Nothing reported.</li>
      {/each}
    </ul>
    <p class="reported" data-reported-by>
      Reported by {report.server}. This wallet doesn't verify it.
    </p>
    {#if shown?.refreshing || shown?.error !== undefined}
      <p class="muted small" data-read-at>
        {#if shown?.refreshing}<span class="spinner"></span>{/if}
        Last read at {readAt(report)}{shown?.refreshing ? "; refreshing…" : "."}
      </p>
    {/if}
  {/if}
{/snippet}

{#snippet pendingDeposits(slot: number)}
  {@const list = deposits[slot]}
  {#if list !== undefined && "error" in list}
    <p class="error small" data-deposits-error>Deposits unavailable: {list.error}</p>
  {:else if list !== undefined && list.length > 0}
    <div class="deposits">
      <h2>Deposits from eCash</h2>
      <ul class="stack">
        {#each list as d (d.txid)}
          <li class="deposit" data-deposit={d.txid} data-deposit-state={d.state}>
            <div class="deposit-head">
              <strong>{d.value} sats</strong>
              <button class="small-button" onclick={() => dismiss(slot, d.txid)} data-deposit-dismiss>Dismiss</button>
            </div>
            <span class="small" data-deposit-status>{depositState(d)}</span>
            {#if d.state === "awaitingCredit"}
              <details data-claim>
                <summary>Show claim details</summary>
                <p class="muted small">
                  Anyone running the chain's node can credit it with <code>importdrivechaindeposit</code> and these arguments:
                </p>
                <dl class="claim">
                  <dt>txid</dt><dd><code data-claim-txid>{d.claim.txid}</code></dd>
                  <dt>vout</dt><dd><code data-claim-vout>{d.claim.vout}</code></dd>
                  <dt>Block hash</dt><dd><code data-claim-block>{d.claim.blockHash}</code></dd>
                  <dt>Address</dt><dd><code data-claim-address>{d.claim.address}</code></dd>
                  <dt>Value (sats)</dt><dd><code data-claim-value>{d.claim.value}</code></dd>
                </dl>
              </details>
            {/if}
          </li>
        {/each}
      </ul>
    </div>
  {/if}
{/snippet}

{#snippet receiveAddress(address: string)}
  <div class="receive">
    <h2>Receive address</h2>
    <code data-receive-address>{address}</code>
  </div>
{/snippet}

{#snippet lockButton()}
  <button class="small-button" disabled={busy} onclick={() => act(lockVault)} data-lock>
    <Icon name="lock" size={16} /> Lock
  </button>
{/snippet}

<main class="screen" data-wallet-home data-wallet-ready={status ? true : undefined} data-vault-state={vaultState}>
  {#if vaultState === "onboarding"}
    <div class="hero">
      <Mark size={56} />
      <h1>ECX Wallet</h1>
      <p>Set up your wallet. One Master Mnemonic (a 12- or 24-word phrase) controls your funds on eCash and its sidechains.</p>
    </div>
    <nav class="stack">
      <a class="button primary block" href="#/create" data-start-create>Create a new wallet</a>
      <a class="button block" href="#/import" data-start-import>Import a Master Mnemonic</a>
    </nav>
    <p class="notice">
      <Icon name="shield" />
      <span>The wallet stores your Master Mnemonic only encrypted with your password, and never unencrypted.</span>
    </p>
  {:else if vaultState === "locked"}
    <TopBar title="ECX Wallet" />
    <form
      class="card unlock"
      onsubmit={(e) => {
        e.preventDefault();
        act(() => unlockVault(password));
      }}
    >
      <span class="lock-icon"><Icon name="lock" size={26} /></span>
      <h1>Unlock your wallet</h1>
      <label>
        Password
        <input type="password" autocomplete="current-password" bind:value={password} data-password />
      </label>
      <button class="primary block" type="submit" disabled={busy} data-unlock>Unlock</button>
    </form>
  {:else if vaultState === "unlocked"}
    <TopBar title="ECX Wallet" actions={lockButton} />
    <p class="muted small status"><span class="dot"></span>Your wallet is unlocked. It locks itself after 15 minutes without use.</p>
    {#if l1Address !== undefined}
      <section class="card" data-account="l1" data-refreshing={l1Report?.refreshing !== false ? "" : undefined}>
        <div class="account-head">
          <h2>eCash</h2>
          <span class="chip" data-account-chain>{l1Address.chain}</span>
        </div>
        {@render reported(l1Report)}
        {@render receiveAddress(l1Address.address)}
      </section>
    {/if}
    {#each accounts ?? [] as account (account.slot)}
      {#each account.addresses.slice(0, 1) as { chain, address } (address)}
        {@const report = reports[account.slot]}
        <section
          class="card"
          data-account={account.slot}
          data-refreshing={report?.refreshing !== false ? "" : undefined}
          data-deposits-ready={deposits[account.slot] !== undefined ? "" : undefined}
        >
          <div class="account-head">
            <h2>Slot {account.slot}</h2>
            <span class="chip" data-account-chain>{chain}</span>
          </div>
          {@render reported(report)}
          {@render pendingDeposits(account.slot)}
          {#if report?.report !== undefined && report.error === undefined}
            <a class="button primary block" href="#/send/{account.slot}" data-send-link><Icon name="send" /> Send</a>
          {/if}
          <a class="button block" href="#/deposit/{account.slot}" data-deposit-link><Icon name="deposit" /> Deposit from eCash</a>
          {@render receiveAddress(address)}
        </section>
      {/each}
    {/each}
  {/if}

  {#if error}
    <p class="error" role="alert" data-error>{error}</p>
  {/if}

  {#if status?.exists}
    <a class="card nav-row" href="#/grants" data-grants-link>
      <span class="stack-tight">
        <strong>Grants</strong>
        <span class="muted small">Sites you've let use your wallet</span>
      </span>
      <Icon name="forward" />
    </a>
  {/if}
</main>

<style>
  .hero {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: 24px 8px 8px;
    text-align: center;
  }
  .hero h1 {
    font-size: 1.6rem;
  }
  .unlock {
    align-items: center;
    text-align: center;
    padding: 28px 20px 20px;
  }
  .unlock label {
    align-self: stretch;
    text-align: left;
  }
  .lock-icon {
    display: flex;
    padding: 14px;
    border-radius: 50%;
    background: var(--surface-2);
    color: var(--accent);
  }
  .status {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--ok);
    flex: none;
  }
  .account-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .balances {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .balances li {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
  }
  .amount {
    font-size: 1.6rem;
  }
  .receive {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding-top: 12px;
    border-top: 1px solid var(--border);
  }
  .receive code {
    padding: 10px 12px;
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    user-select: all;
  }
  .deposits {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-top: 12px;
    border-top: 1px solid var(--border);
  }
  .deposit {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .deposit-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .claim {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 2px 10px;
    font-size: 0.8rem;
  }
  .claim dd {
    overflow-wrap: anywhere;
  }
  .nav-row {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    color: var(--text);
    text-decoration: none;
  }
  .nav-row:hover {
    background: var(--surface-2);
  }
  .stack-tight {
    display: flex;
    flex-direction: column;
  }
</style>
