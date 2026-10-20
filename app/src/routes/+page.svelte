<script lang="ts">
  import {
    l1Account,
    l1Reported,
    listAccounts,
    lockVault,
    reportedState,
    unlockVault,
    vaultStatus,
    type ChainReport,
    type SlotAccount,
    type SlotReport,
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
  let l1Report = $state<ChainReport | { error: string } | undefined>(undefined);
  /** Per Slot: what its Sidechain Server reports, or why it couldn't be read. */
  let reports = $state<Record<number, SlotReport | { error: string }>>({});
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
    l1Reported().then(
      (r) => (l1Report = r),
      (e) => (l1Report = { error: (e as Error).message }),
    );
    listAccounts().then(
      (a) => {
        accounts = a;
        for (const { slot } of a) {
          reportedState(slot).then(
            (r) => (reports[slot] = r),
            (e) => (reports[slot] = { error: (e as Error).message }),
          );
        }
      },
      (e) => (error = (e as Error).message),
    );
  });

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

{#snippet reported(report: ChainReport | { error: string } | undefined)}
  {#if report === undefined}
    <p class="loading small"><span class="spinner"></span>Asking the Sidechain Server for your balance…</p>
  {:else if "error" in report}
    <p class="error" data-balance-error>Balance unavailable: {report.error}</p>
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
      <section class="card" data-account="l1">
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
        <section class="card" data-account={account.slot}>
          <div class="account-head">
            <h2>Slot {account.slot}</h2>
            <span class="chip" data-account-chain>{chain}</span>
          </div>
          {@render reported(report)}
          {#if report !== undefined && !("error" in report)}
            <a class="button primary block" href="#/send/{account.slot}" data-send-link><Icon name="send" /> Send</a>
          {/if}
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
