<script lang="ts">
  import { cachedState, listChains, listDeposits, reportedState, setChainOn, type ChainInfo } from "$lib/background";
  import ChainMark from "$lib/ChainMark.svelte";
  import { chainMark } from "$lib/chains.svelte";
  import Sheet from "$lib/Sheet.svelte";
  import TopBar from "$lib/TopBar.svelte";
  import { amountText } from "$lib/unit.svelte";

  let chains = $state<ChainInfo[] | undefined>(undefined);
  let error = $state("");
  /** A chain being turned off that still holds something: the user confirms first. */
  let confirming = $state<{ chain: ChainInfo; holds: string } | undefined>(undefined);
  let busy = $state(false);

  const load = () => listChains().then((c) => (chains = c), (e) => (error = (e as Error).message));
  load();

  async function set(chain: ChainInfo, on: boolean) {
    busy = true;
    error = "";
    try {
      await setChainOn(chain.id as number, on);
      confirming = undefined;
      await load();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }

  /** What turning `chain` off would hide, in words; "" if nothing. */
  async function holdings(chain: ChainInfo): Promise<string> {
    const slot = chain.id as number;
    const ecx = chain.assets.find((a) => a.ecx);
    const report = (await cachedState(slot).catch(() => null)) ?? (await reportedState(slot).catch(() => null));
    const balance = ecx && report?.balances.find((b) => b.asset === ecx.id && b.amount !== "0");
    const deposits = (await listDeposits(slot).catch(() => [])).filter((d) => d.state === "confirming" || d.state === "awaitingCredit");
    const parts = [
      ...(balance ? [`Your ${amountText(balance.amount, balance.asset, chain.assets)} on ${chain.name} stays there.`] : []),
      ...(deposits.length > 0 ? [`Your Deposits in progress to it still show under Activity.`] : []),
    ];
    return parts.length === 0 ? "" : `${parts.join(" ")} It's hidden until you turn the chain back on.`;
  }

  async function toggle(chain: ChainInfo) {
    if (chain.on) {
      busy = true;
      const holds = await holdings(chain);
      busy = false;
      if (holds) {
        confirming = { chain, holds };
        return;
      }
    }
    await set(chain, !chain.on);
  }
</script>

<main class="screen" data-screen-ready={chains ? "" : undefined} data-chains>
  <TopBar title="Chains" back="#/" />
  <p class="muted small">Turn on the chains you use. Turning one off only hides it: your funds on it stay where they are.</p>

  {#if chains}
    <ul class="card chains">
      {#each chains as chain (chain.id)}
        <li class="chain" data-chain={chain.id}>
          <ChainMark {...chainMark(chain)} size={32} />
          <span class="grow">
            <strong class="small">{chain.name}</strong>
            <span class="muted tiny">{chain.description} · <span class="mono">{chain.chain}</span></span>
          </span>
          {#if chain.id === "l1"}
            <span class="muted tiny" data-always-on>Always on</span>
          {:else}
            <button
              class="switch"
              role="switch"
              aria-checked={chain.on}
              aria-label="Show {chain.name}"
              disabled={busy}
              onclick={() => toggle(chain)}
              data-chain-switch={chain.id}
            >
              <span></span>
            </button>
          {/if}
        </li>
      {/each}
    </ul>
    <p class="muted tiny">These are the chains this version of the wallet supports. New chains come with wallet updates.</p>
  {/if}
  {#if error}<p class="error" role="alert" data-error>{error}</p>{/if}
</main>

{#if confirming}
  {@const { chain, holds } = confirming}
  <Sheet title="Turn off {chain.name}?" onclose={() => (confirming = undefined)} data-turn-off-sheet>
    <p class="small" data-turn-off-holds>{holds}</p>
    <div class="choices">
      <button onclick={() => (confirming = undefined)} data-keep-on>Keep it on</button>
      <button class="primary" disabled={busy} onclick={() => set(chain, false)} data-turn-off>Turn off</button>
    </div>
  </Sheet>
{/if}

<style>
  .chains {
    gap: 0;
    padding: 0 14px;
  }
  .chain {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 0;
  }
  .chain + .chain {
    border-top: 1px solid var(--border);
  }
  .grow {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .switch {
    position: relative;
    flex: none;
    width: 40px;
    height: 24px;
    min-height: 0;
    padding: 0;
    border: none;
    border-radius: 999px;
    background: var(--border);
  }
  .switch span {
    position: absolute;
    top: 3px;
    left: 3px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: #fff;
    transition: left 0.15s;
  }
  .switch[aria-checked="true"] {
    background: var(--accent);
  }
  .switch[aria-checked="true"] span {
    left: 19px;
  }
  .choices {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }
</style>
