// Per-Slot accounts: which Chain Module serves a Slot, and the addresses it derives. Routing rule
// (spec #18, story 44): a Slot's Chain Module only ever receives that Slot's Starter.
import { loadChainModule, type ChainModule } from "./chain-module";

/** Slots with a bundled Chain Module, and the .wasm each ships as. */
export const CHAIN_MODULE_FILES: Readonly<Record<number, string>> = { 24: "elements.wasm" };

export const SUPPORTED_SLOTS: readonly number[] = Object.keys(CHAIN_MODULE_FILES).map(Number);

/**
 * Lazily instantiates each Slot's Chain Module, once, in its own WASM instance. `fetchWasm` gets a
 * shipped file's bytes (the background fetches it from the extension package).
 */
export function createChainModules(fetchWasm: (file: string) => Promise<BufferSource>) {
  const loaded = new Map<number, Promise<ChainModule>>();
  return function chainModule(slot: number): Promise<ChainModule> | undefined {
    const file = CHAIN_MODULE_FILES[slot];
    if (file === undefined) return undefined;
    let module = loaded.get(slot);
    if (module === undefined) {
      module = fetchWasm(file).then(loadChainModule);
      module.catch(() => loaded.delete(slot));
      loaded.set(slot, module);
    }
    return module;
  };
}

/** An address as the Provider and the account screen give it out. */
export interface SlotAddress {
  /** CAIP-2, e.g. `ecash:betanet-s24`. */
  chain: string;
  /** In the chain's own encoding. */
  address: string;
}

/** The Slot's Chain Module and the chain it serves; throws if the wallet has none for the Slot. */
export async function slotChainModule(
  chainModule: (slot: number) => Promise<ChainModule> | undefined,
  slot: number,
): Promise<{ module: ChainModule; chain: string }> {
  const pending = chainModule(slot);
  if (pending === undefined) throw new Error(`No Chain Module for Slot ${slot}.`);
  const module = await pending;
  return { module, chain: module.declare().binding.chain };
}

export interface AccountsDeps {
  /** The Slot's Starter; throws while the wallet is locked. */
  starter(slot: number): Promise<string>;
  chainModule(slot: number): Promise<ChainModule> | undefined;
}

export function createAccounts({ starter, chainModule }: AccountsDeps) {
  return {
    /** The Slot's receive address(es), derived by its Chain Module from its Starter alone. */
    async receiveAddresses(slot: number): Promise<SlotAddress[]> {
      const { module, chain } = await slotChainModule(chainModule, slot);
      const account = module.deriveAccount(await starter(slot), { receive: 1 });
      return account.receive.map(({ address }) => ({ chain, address }));
    },
  };
}

export type Accounts = ReturnType<typeof createAccounts>;
