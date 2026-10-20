<script lang="ts">
  import { goto } from "$app/navigation";
  import { checkNewPassword, createVault, generateMnemonic, vaultStatus } from "$lib/background";
  import PasswordFields from "$lib/PasswordFields.svelte";

  /** How many words of the phrase the user must type back. */
  const CONFIRM_COUNT = 3;

  type Step = "loading" | "exists" | "show" | "confirm";
  let step = $state<Step>("loading");
  let words = $state<string[]>([]);
  let positions = $state<number[]>([]);
  let typed = $state<Record<number, string>>({});
  let password = $state("");
  let repeat = $state("");
  let error = $state("");
  let busy = $state(false);

  vaultStatus().then(async (status) => {
    if (status.exists) {
      step = "exists";
      return;
    }
    words = (await generateMnemonic()).split(" ");
    step = "show";
  });

  /** Distinct 1-based word positions, chosen at random, in order. */
  function pickPositions(): number[] {
    const picked = new Set<number>();
    const random = new Uint32Array(1);
    while (picked.size < CONFIRM_COUNT) {
      crypto.getRandomValues(random);
      picked.add((random[0] % words.length) + 1);
    }
    return [...picked].sort((a, b) => a - b);
  }

  function phraseSaved() {
    positions = pickPositions();
    typed = Object.fromEntries(positions.map((n) => [n, ""]));
    step = "confirm"; // the phrase is never shown again
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    error = "";
    const wrong = positions.find((n) => (typed[n] ?? "").trim().toLowerCase() !== words[n - 1]);
    if (wrong !== undefined) {
      error = `Word #${wrong} doesn't match your recovery phrase.`;
      return;
    }
    error = checkNewPassword(password, repeat);
    if (error) return;
    busy = true;
    try {
      await createVault({ masterMnemonic: words.join(" "), password });
      words = [];
      await goto("#/", { replaceState: true });
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<main data-wallet-ready={step === "loading" ? undefined : true}>
  <h1>Create a wallet</h1>

  {#if step === "exists"}
    <p data-already-exists>This browser already has a wallet.</p>
    <a href="#/">Back</a>
  {:else if step === "show"}
    <p>
      This is your recovery phrase. Write it down, in order, and keep it somewhere safe and offline.
      It will not be shown again. Anyone who has it controls your funds.
    </p>
    <ol class="phrase" data-phrase>
      {#each words as word, i (i)}
        <li data-word>{word}</li>
      {/each}
    </ol>
    <button onclick={phraseSaved} data-phrase-saved>I've written it down</button>
  {:else if step === "confirm"}
    <form onsubmit={submit}>
      <p>To check your backup, type these words from your recovery phrase.</p>
      {#each positions as n (n)}
        <label>
          Word #{n}
          <input
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            bind:value={typed[n]}
            data-confirm-word={n}
          />
        </label>
      {/each}
      <PasswordFields bind:password bind:repeat />
      <button type="submit" disabled={busy} data-submit>Create wallet</button>
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
  .phrase {
    columns: 2;
    font-family: ui-monospace, monospace;
    font-size: 1.1rem;
  }
  label {
    display: block;
    margin-bottom: 0.5rem;
  }
  .error {
    color: #b00020;
  }
</style>
