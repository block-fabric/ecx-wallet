<script lang="ts">
  import { goto } from "$app/navigation";
  import { checkNewPassword, createVault, generateMnemonic, vaultStatus } from "$lib/background";
  import Icon from "$lib/Icon.svelte";
  import PasswordFields from "$lib/PasswordFields.svelte";
  import TopBar from "$lib/TopBar.svelte";

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
      error = `Word #${wrong} doesn't match your Master Mnemonic.`;
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

<main class="screen" data-wallet-ready={step === "loading" ? undefined : true}>
  <TopBar title="Create a wallet" back="#/" />

  {#if step === "exists"}
    <p class="notice" data-already-exists>This browser already has a wallet.</p>
    <a class="button block" href="#/">Back</a>
  {:else if step === "show"}
    <p>This is your Master Mnemonic ({words.length} words). Write it down, in order, and keep it somewhere safe and offline.</p>
    <ol class="phrase" style:--rows={Math.ceil(words.length / 2)} data-phrase>
      {#each words as word, i (i)}
        <li data-word>{word}</li>
      {/each}
    </ol>
    <p class="error warning">
      <Icon name="warning" />
      <span>It will not be shown again. Anyone who has it controls your funds.</span>
    </p>
    <button class="primary block" onclick={phraseSaved} data-phrase-saved>I've written it down</button>
  {:else if step === "confirm"}
    <form class="stack" onsubmit={submit}>
      <p>To check your backup, type these words from your Master Mnemonic.</p>
      <div class="card">
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
      </div>
      <div class="card">
        <PasswordFields bind:password bind:repeat />
      </div>
      <button class="primary block" type="submit" disabled={busy} data-submit>Create wallet</button>
    </form>
  {/if}

  {#if error}
    <p class="error" role="alert" data-error>{error}</p>
  {/if}
</main>

<style>
  .phrase {
    display: grid;
    grid-template-columns: 1fr 1fr;
    grid-auto-flow: column;
    grid-template-rows: repeat(var(--rows, 6), auto);
    gap: 8px;
    counter-reset: word;
  }
  .phrase li {
    counter-increment: word;
    display: flex;
    gap: 8px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    font-family: var(--mono);
    font-size: 0.95rem;
  }
  /* The number is drawn, not text: the word's own text stays exactly the word. */
  .phrase li::before {
    content: counter(word);
    min-width: 1.5em;
    color: var(--muted);
    text-align: right;
  }
  .warning {
    display: flex;
    gap: 10px;
  }
</style>
