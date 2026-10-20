<script lang="ts">
  import { goto } from "$app/navigation";
  import { checkNewPassword, createVault, vaultStatus } from "$lib/background";
  import PasswordFields from "$lib/PasswordFields.svelte";

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

<main data-wallet-ready={exists === undefined ? undefined : true}>
  <h1>Import a wallet</h1>

  {#if exists}
    <p data-already-exists>This browser already has a wallet.</p>
    <a href="#/">Back</a>
  {:else if exists === false}
    <form onsubmit={submit}>
      <label>
        Recovery phrase (12 or 24 words)
        <textarea
          rows="3"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          bind:value={phrase}
          data-import-phrase
        ></textarea>
      </label>
      <label>
        Passphrase (optional; only if you added one to this phrase)
        <input type="password" autocomplete="off" bind:value={passphrase} data-import-passphrase />
      </label>
      <PasswordFields bind:password bind:repeat />
      <button type="submit" disabled={busy} data-submit>Import wallet</button>
    </form>
  {/if}

  {#if error}
    <p class="error" role="alert" data-error>{error}</p>
  {/if}
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
  textarea {
    width: 100%;
  }
  .error {
    color: #b00020;
  }
</style>
