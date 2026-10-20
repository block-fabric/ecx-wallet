<script lang="ts">
  import { listAccounts, lockVault, unlockVault, vaultStatus, type SlotAccount, type VaultStatus } from "$lib/background";

  let status = $state<VaultStatus | undefined>(undefined);
  let accounts = $state<SlotAccount[] | undefined>(undefined);
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
      (a) => (accounts = a),
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
    <p>Set up your wallet. One recovery phrase controls your funds on eCash and its sidechains.</p>
    <p>
      The wallet stores your recovery phrase only encrypted with your password, and never unencrypted.
    </p>
    <nav class="actions">
      <a href="#/create" data-start-create>Create a new wallet</a>
      <a href="#/import" data-start-import>Import a recovery phrase</a>
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
        <section class="account" data-account={account.slot}>
          <h2>Slot {account.slot} <small data-account-chain>{chain}</small></h2>
          <p>Receive address</p>
          <code data-receive-address>{address}</code>
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
  .error {
    color: #b00020;
  }
</style>
