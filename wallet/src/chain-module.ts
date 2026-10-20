// Typed access to a Chain Module's .wasm (today: core/elements-wasm as elements.wasm). The shape
// follows the spec's Chain Module interface; decode(request) and sign(request, starter) join it in
// later tickets. A module returns data only and holds nothing: it gets its own Slot's Starter per call.
import { CoreModule } from "./wasm";

/** What a module serves: Signing Requests for `chain` in `format`. */
export interface Binding {
  /** CAIP-2 in our own namespace, e.g. `ecash:betanet-s24`. */
  chain: string;
  format: string;
  payloadVersions: string[];
}

export interface Declaration {
  binding: Binding;
  /** Optional capabilities; none in the skeleton. */
  capabilities: string[];
}

/** One network of a sidechain, as its Chain Entry describes it. */
export interface NetworkEntry {
  chain: string;
  genesisHash: string;
  parentGenesisHash: string;
  policyAsset: string;
  addressParams: { p2pkhPrefix: number; p2shPrefix: number; blindedPrefix: number; bechHrp: string; blechHrp: string };
  /** Default Sidechain Server URL. */
  sidechainServer: string;
  /** Official App origins. */
  officialApps: string[];
}

/** The description of one sidechain that ships with its Chain Module. */
export interface ChainEntry {
  slot: number;
  name: string;
  networks: Record<string, NetworkEntry>;
}

export interface DerivedAddress {
  index: number;
  /** In the chain's own encoding (`elements1…` for Slot 24). */
  address: string;
  scriptPubkey: string;
}

/** Addresses and the watch data a Sidechain Server needs. */
export interface Account {
  descriptor: string;
  receive: DerivedAddress[];
}

export interface ChainModule {
  declare(): Declaration;
  chainEntry(): ChainEntry;
  /** The Slot's Starter → its account, with the first `receive` receive addresses. */
  deriveAccount(starter: string, options: { receive: number }): Account;
}

export async function loadChainModule(bytes: BufferSource): Promise<ChainModule> {
  const m = await CoreModule.instantiate(bytes);
  const json = <T>(name: string, ...args: (string | number)[]) => JSON.parse(m.callText(name, ...args)) as T;
  return {
    declare: () => json<Declaration>("declare"),
    chainEntry: () => json<ChainEntry>("chain_entry"),
    deriveAccount: (starter, { receive }) => json<Account>("derive_account", starter, receive),
  };
}
