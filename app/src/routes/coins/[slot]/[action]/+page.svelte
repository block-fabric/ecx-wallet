<script lang="ts">
  // Spending the wallet's ordinary coins on the Sidepot sidechain (docs/adr/0022): `send` pays another
  // Sidepot address, `withdraw` asks for a withdrawal to a main-chain address. Each is approved in
  // place, as the wallet's own Send and Deposit are.
  import { page } from "$app/state";
  import { parseAmount } from "@ecx/wallet";
  import { coinsReported, hostApprovals, listChains, sendCoins, withdrawCoins, type ChainInfo, type SendResult, type SidepotCoinsReport } from "$lib/background";
  import Approval from "$lib/Approval.svelte";
  import Icon from "$lib/Icon.svelte";
  import TopBar from "$lib/TopBar.svelte";
  import { amountText, unit } from "$lib/unit.svelte";

  const slot = Number(page.params.slot);
  const withdrawing = page.params.action === "withdraw";

  let chains = $state<ChainInfo[]>([]);
  listChains().then((c) => (chains = c), () => {});
  const info = $derived(chains.find((c) => c.id === slot));
  const name = $derived(info?.name ?? `Slot ${slot}`);
  const assets = $derived(info?.assets ?? []);
  const ecx = $derived(assets.find((a) => a.id === ""));
  const sats = (amount: string) => amountText(amount, "", assets);

  /** What the chain's server reports of the wallet's coins, or why it couldn't be read. Only to help pick an amount: the spend reads them again. */
  let report = $state<SidepotCoinsReport | undefined>(undefined);
  let reportError = $state("");
  const readCoins = () => coinsReported(slot).then((r) => ((report = r), (reportError = "")), (e) => (reportError = (e as Error).message));
  readCoins();

  let to = $state("");
  let amount = $state("");
  /** A withdrawal's fee for the main chain's miners, as typed: it starts at 1,000 sats, written in the unit amounts are typed in. */
  let mainFee = $state("");
  let prefilled = false;
  $effect(() => {
    if (!unit.loaded || prefilled) return;
    prefilled = true;
    mainFee = unit.value === "sats" ? "1000" : "0.00001";
  });
  /** The user has ticked that they read what a withdrawal means: nothing is built before that. */
  let understood = $state(false);
  let busy = $state(false);
  /** The approval of this screen's own request, shown in place of the form while it waits. */
  let approvalId = $state<string | null>(null);
  let done = $state<SendResult | undefined>(undefined);
  let copied = $state(false);
  let error = $state("");

  const unitName = $derived(unit.value === "ecx" ? "ECX" : "sats");
  /** A typed amount in sats; undefined while it doesn't parse (the request refuses it then, saying why). */
  function typed(text: string): bigint | undefined {
    try {
      return BigInt(parseAmount(text, ecx, unit.value));
    } catch {
      return undefined;
    }
  }
  /** Everything the spend takes from the coins: the amount, a withdrawal's main-chain fee, and Sidepot's own fee. */
  const total = $derived.by(() => {
    const paid = typed(amount);
    const fee = withdrawing ? typed(mainFee) : 0n;
    return paid === undefined || fee === undefined || report === undefined ? undefined : paid + fee + BigInt(report.fee);
  });
  const overspent = $derived(total !== undefined && report !== undefined && total > BigInt(report.balance));

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    error = "";
    done = undefined;
    let pay: { amount: string; mainFee: string };
    try {
      pay = { amount: parseAmount(amount, ecx, unit.value), mainFee: "" };
      if (withdrawing) {
        try {
          pay.mainFee = parseAmount(mainFee, ecx, unit.value);
        } catch (err) {
          throw new Error(`Main-chain fee: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      error = (err as Error).message;
      return;
    }
    busy = true;
    const approvals = hostApprovals((id) => (approvalId = id));
    try {
      done = withdrawing
        ? await withdrawCoins(slot, { mainAddress: to.trim(), amount: pay.amount, mainFee: pay.mainFee }, approvals.host)
        : await sendCoins(slot, { to: to.trim(), amount: pay.amount }, approvals.host);
      // What it spent is held now: the balance above says so.
      void readCoins();
    } catch (err) {
      error = (err as Error).message;
    } finally {
      approvals.stop();
      busy = false;
    }
  }

  function copyTxid(txid: string) {
    navigator.clipboard.writeText(txid).catch(() => {});
    copied = true;
    setTimeout(() => (copied = false), 1500);
  }

  const shortTxid = (txid: string) => `${txid.slice(0, 10)}…${txid.slice(-8)}`;
</script>

{#if approvalId !== null}
  <!-- This screen's own request, approved in place: a window would close the toolbar popup. -->
  {#key approvalId}<Approval id={approvalId} hosted ondone={() => (approvalId = null)} />{/key}
{:else}
<main class="screen" data-screen-ready data-coins-screen={withdrawing ? "withdraw" : "send"}>
  <TopBar title={withdrawing ? `Withdraw from ${name}` : `Send ${name} coins`} back="#/chain/{slot}" />

  <div class="card">
    <span class="muted small">Your coins on {name}</span>
    {#if report}
      <strong class="amount" data-coins-available>{sats(report.balance)}</strong>
      {#if report.held !== "0"}
        <span class="muted small" data-coins-held>{sats(report.held)} held by a transaction waiting to confirm</span>
      {/if}
      <p class="reported">Reported by {report.server}. This wallet doesn't verify it.</p>
    {:else if reportError}
      <p class="error small" data-balance-error>Balance unavailable: {reportError}</p>
    {:else}
      <p class="loading small"><span class="spinner"></span>Asking its server for your coins…</p>
    {/if}
  </div>

  {#if done}
    <div class="success sent" role="status" data-coins-done>
      <strong>{withdrawing ? "Withdrawal requested" : "Sent"}</strong>
      {#if done.txid}
        <span class="txid">
          Transaction <code data-coins-txid={done.txid}>{shortTxid(done.txid)}</code>
          <button type="button" class="copy" aria-label="Copy the transaction id" title="Copy" onclick={() => copyTxid(done!.txid!)} data-copy-txid>
            <Icon name={copied ? "check" : "copy"} size={16} />
          </button>
        </span>
      {/if}
      <span>
        {withdrawing
          ? `${name}'s node took it. It shows under Withdrawals waiting on ${name}'s screen.`
          : `${name}'s node took it. Your balance shows it once it is in a block.`}
      </span>
      <a class="link" href="#/chain/{slot}" data-coins-back>Back to {name}</a>
    </div>
  {:else}
    <form class="stack" onsubmit={submit}>
      <div class="card">
        <label>
          {withdrawing ? "Main-chain (eCash) address" : `${name} address`}
          <input class="mono" bind:value={to} autocomplete="off" spellcheck="false" data-coins-destination />
        </label>
        <label>
          Amount ({unitName})
          <input inputmode="decimal" bind:value={amount} autocomplete="off" data-coins-amount />
        </label>
        {#if withdrawing}
          <label>
            Main-chain fee ({unitName})
            <input inputmode="decimal" bind:value={mainFee} autocomplete="off" data-coins-main-fee />
          </label>
          <span class="muted tiny">
            Paid to the main chain's miners with the withdrawal, on top of the amount. A bundle that pays them more is worth more to include.
          </span>
        {/if}
      </div>
      {#if total !== undefined && report}
        <p class="muted small" data-coins-total>
          Takes {sats(total.toString())} from your coins: the amount{withdrawing ? ", the main-chain fee" : ""} and {name}'s own {sats(report.fee)} fee.
        </p>
      {/if}
      {#if overspent}
        <p class="error" role="alert" data-coins-overspent>That is more than your coins on {name} hold. Lower the amount{withdrawing ? " or the fee" : ""}.</p>
      {/if}
      {#if withdrawing}
        <p class="notice" data-coins-withdraw-note>
          <Icon name="warning" />
          <span>
            A withdrawal is slow, and it depends on the main chain's miners. {name} gathers waiting withdrawals into a bundle, and the
            miners vote on that bundle block by block, for a long time, before the main chain pays it. If they don't approve it, nothing
            is paid and the withdrawal waits for the next bundle.
          </span>
        </p>
        <div class="card disclaimer" data-coins-withdraw-disclaimer>
          <strong>Before you ask for a withdrawal</strong>
          <ul>
            <li>It can't be cancelled. From the moment you ask, the amount and its main-chain fee are set aside: you can't spend them, send them or put them back in the game.</li>
            <li>Nobody can say when it will be paid, or promise that it will be. It is paid only when a bundle that includes it wins the miners' vote on the main chain.</li>
            <li>A wrong main-chain address can't be corrected afterwards.</li>
          </ul>
          {#if report?.withdrawalNotice}
            <p class="operator" data-coins-withdraw-notice>
              <span class="muted small">From {name}'s operator, by way of {report.server}:</span>
              {report.withdrawalNotice}
            </p>
          {/if}
          <label class="agree">
            <input type="checkbox" bind:checked={understood} data-coins-understood />
            <span>I understand, and I want to ask for this withdrawal.</span>
          </label>
        </div>
      {:else}
        <p class="notice" data-coins-send-note>
          <Icon name="warning" />
          <span>
            This pays a {name} sidechain address: about 27 letters and digits, with no prefix. Nothing in such an address catches a typo,
            so paste it and check its first and last characters. Coins sent to a wrong address are lost.
          </span>
        </p>
      {/if}
      <!-- Not a server's report: the screen's one "Reported by" notice is the balance card's. -->
      <p class="muted small" data-builds-note>
        This wallet builds the transaction from your own coins. You review exactly what it built before anything is signed.
      </p>
      <button class="primary block" type="submit" disabled={busy || to.trim() === "" || amount.trim() === "" || (withdrawing && !understood)} data-coins-submit>
        {withdrawing ? "Review withdrawal" : "Review and send"}
      </button>
    </form>
    {#if busy}
      <p class="loading small" data-coins-waiting><span class="spinner"></span>Reading your coins and building the transaction, then waiting for your approval…</p>
    {/if}
  {/if}

  {#if error}<p class="error" role="alert" data-error>{error}</p>{/if}
</main>
{/if}

<style>
  .disclaimer {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .disclaimer ul {
    margin: 0;
    padding-left: 1.1rem;
    list-style: disc;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .operator {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .agree {
    display: flex;
    flex-direction: row;
    align-items: flex-start;
    gap: 8px;
  }
  .agree input {
    width: auto;
    margin-top: 3px;
  }
  .amount {
    font-size: 1.6rem;
  }
  .sent {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .txid {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .copy {
    width: 32px;
    min-height: 32px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: none;
    color: inherit;
  }
</style>
