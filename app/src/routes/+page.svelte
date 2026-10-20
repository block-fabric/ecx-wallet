<script lang="ts">
  import {
    listAccounts,
    lockVault,
    reportedState,
    unlockVault,
    vaultStatus,
    type SlotAccount,
    type SlotReport,
    type VaultStatus,
  } from "$lib/background";

  let status = $state<VaultStatus | undefined>(undefined);
  let accounts = $state<SlotAccount[] | undefined>(undefined);
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
      return;
    }
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

<main data-wallet-home data-wallet-ready={status ? true : undefined} data-vault-state={vaultState}>
  <h1>ECX Wallet</h1>

  {#if vaultState === "onboarding"}
    <p>Set up your wallet. One Master Mnemonic (a 12- or 24-word phrase) controls your funds on eCash and its sidechains.</p>
    <p>
      The wallet stores your Master Mnemonic only encrypted with your password, and never unencrypted.
    </p>
    <nav class="actions">
      <a href="#/create" data-start-create>Create a new wallet</a>
      <a href="#/import" data-start-import>Import a Master Mnemonic</a>
    </nav>
  {:else if vaultState === "locked"}
    <form
      onsubmit={(e) => {
        e.preventDefault();
        act(() => unlockVault(password));
      }}
    >
      <label>
        Password
        <input type="password" autocomplete="current-password" bind:value={password} data-password />
      </label>
      <button type="submit" disabled={busy} data-unlock>Unlock</button>
    </form>
  {:else if vaultState === "unlocked"}
    <p>Your wallet is unlocked. It locks itself after 15 minutes without use.</p>
    {#each accounts ?? [] as account (account.slot)}
      {#each account.addresses.slice(0, 1) as { chain, address } (address)}
        {@const report = reports[account.slot]}
        <section class="account" data-account={account.slot}>
          <h2>Slot {account.slot} <small data-account-chain>{chain}</small></h2>
          <p>Receive address</p>
          <code data-receive-address>{address}</code>
          {#if report === undefined}
            <p>Asking the Sidechain Server for your balance…</p>
          {:else if "error" in report}
            <p class="error" data-balance-error>Balance unavailable: {report.error}</p>
          {:else}
            <h3>Balance</h3>
            <p class="reported" data-reported-by>
              Reported by {report.server}. This wallet doesn't verify it.
            </p>
            <ul class="balances">
              {#each report.balances as balance (balance.asset)}
                <li data-balance data-asset={balance.asset}>
                  <strong>{balance.amount}</strong> <span class="asset">asset <code>{balance.asset}</code></span>
                </li>
              {:else}
                <li data-no-balance>Nothing reported.</li>
              {/each}
            </ul>
            <a href="#/send/{account.slot}" data-send-link>Send</a>
          {/if}
        </section>
      {/each}
    {/each}
    <button disabled={busy} onclick={() => act(lockVault)} data-lock>Lock</button>
  {/if}

  {#if error}
    <p class="error" role="alert" data-error>{error}</p>
  {/if}

  {#if status?.exists}
    <nav><a href="#/grants" data-grants-link>Connected sites</a></nav>
  {/if}
</main>

<style>
  main {
    font-family: system-ui, sans-serif;
    padding: 1rem;
    max-width: 30rem;
  }
  .actions {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  label {
    display: block;
    margin-bottom: 0.5rem;
  }
  .account code {
    display: block;
    word-break: break-all;
    margin-bottom: 1rem;
  }
  .reported {
    font-style: italic;
    color: #555;
  }
  .balances code {
    word-break: break-all;
    font-size: 0.8em;
  }
  .error {
    color: #b00020;
  }
</style>
