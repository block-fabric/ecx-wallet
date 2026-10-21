<script lang="ts">
  import { page } from "$app/state";
  import { parseAmount } from "@ecx/wallet";
  import { shortAsset } from "$lib/asset";
  import { listChains, reportedState, startSend, type ChainInfo, type SendResult, type SlotReport } from "$lib/background";
  import TopBar from "$lib/TopBar.svelte";
  import { amountText, unit } from "$lib/unit.svelte";

  const slot = Number(page.params.slot);
  let info = $state<ChainInfo | undefined>(undefined);
  listChains().then((c) => (info = c.find((i) => i.id === slot)), () => {});
  const assets = $derived(info?.assets ?? []);
  const entry = $derived(assets.find((a) => a.id === asset));
  /** What the amount is typed in: ECX in the chosen unit, another named asset in its own, else base units. */
  const amountUnit = $derived(entry === undefined ? "base units" : entry.ecx && unit.value === "sats" ? "sats" : entry.ticker);
  let report = $state<SlotReport | undefined>(undefined);
  let loaded = $state(false);
  let asset = $state("");
  let amount = $state("");
  let destination = $state("");
  let busy = $state(false);
  let done = $state<SendResult | undefined>(undefined);
  let error = $state("");

  // The assets to send are the ones the Sidechain Server reports a balance of.
  reportedState(slot).then(
    (r) => {
      report = r;
      asset = r.balances[0]?.asset ?? "";
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
      done = await startSend({ slot, asset, amount: parseAmount(amount, entry, unit.value), destination: destination.trim() });
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<main class="screen" data-screen-ready={loaded ? "" : undefined}>
  <TopBar title="Send on {info?.name ?? `Slot ${slot}`}" back="#/chain/{slot}" />

  {#if !loaded}
    <p class="loading"><span class="spinner"></span>Loading…</p>
  {/if}

  {#if report}
    <form class="stack" onsubmit={submit}>
      <div class="card">
        <label>
          Asset
          <select bind:value={asset} data-send-asset>
            {#each report.balances as balance (balance.asset)}
              {@const named = assets.find((a) => a.id === balance.asset)}
              <option value={balance.asset}>
                {named ? named.ticker : `Unknown asset ${shortAsset(balance.asset)}`} ({amountText(balance.amount, balance.asset, assets)} reported)
              </option>
            {/each}
          </select>
        </label>
        <label>
          Amount ({amountUnit})
          <input inputmode="decimal" bind:value={amount} data-send-amount />
        </label>
        <label>
          Destination address
          <input class="mono" bind:value={destination} autocomplete="off" spellcheck="false" data-send-destination />
        </label>
      </div>
      <p class="reported">
        The Sidechain Server at <strong data-server>{report.server}</strong> builds the transaction. You review
        exactly what it built, decoded by this wallet, before anything is signed.
      </p>
      <button class="primary block" type="submit" disabled={busy || !asset} data-send-submit>Review and send</button>
    </form>
    {#if busy}<p class="loading small" data-send-waiting><span class="spinner"></span>Waiting for the Sidechain Server and your approval…</p>{/if}
  {/if}

  {#if done}
    <p class="success" role="status" data-send-done>
      Signed and submitted to {done.server}{done.accepted ? "" : ", which didn't accept it"}.
      {#if done.txid}Transaction <code>{done.txid}</code>.{/if}
    </p>
  {/if}
  {#if error}<p class="error" role="alert" data-error>{error}</p>{/if}
</main>
