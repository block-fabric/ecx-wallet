<script lang="ts">
  import { goto } from "$app/navigation";
  import { checkNewPassword, createVault, vaultStatus } from "$lib/background";
  import PasswordFields from "$lib/PasswordFields.svelte";
  import TopBar from "$lib/TopBar.svelte";

  let exists = $state<boolean | undefined>(undefined);
  let phrase = $state("");
  let passphrase = $state("");
  let password = $state("");
  let repeat = $state("");
  let error = $state("");
  let busy = $state(false);

  vaultStatus().then((status) => (exists = status.exists));

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    error = checkNewPassword(password, repeat);
    if (error) return;
    busy = true;
    try {
      await createVault({ masterMnemonic: phrase, passphrase, password });
      phrase = passphrase = password = repeat = "";
      await goto("#/", { replaceState: true });
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<main class="screen" data-wallet-ready={exists === undefined ? undefined : true}>
  <TopBar title="Import a wallet" back="#/" />

  {#if exists}
    <p class="notice" data-already-exists>This browser already has a wallet.</p>
    <a class="button block" href="#/">Back</a>
  {:else if exists === false}
    <form class="stack" onsubmit={submit}>
      <div class="card">
        <label>
          Master Mnemonic (12 or 24 words)
          <textarea
            rows="4"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            bind:value={phrase}
            data-import-phrase
          ></textarea>
        </label>
        <label>
          Passphrase (optional; only if you added one to this Master Mnemonic)
          <input type="password" autocomplete="off" bind:value={passphrase} data-import-passphrase />
        </label>
      </div>
      <div class="card">
        <PasswordFields bind:password bind:repeat />
      </div>
      <button class="primary block" type="submit" disabled={busy} data-submit>Import wallet</button>
    </form>
  {/if}

  {#if error}
    <p class="error" role="alert" data-error>{error}</p>
  {/if}
</main>
