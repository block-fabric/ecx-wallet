// Typed access to a Chain Module's .wasm (today: core/elements-wasm as elements.wasm). The shape
// follows the spec's Chain Module interface. A module returns data only and holds nothing: it gets
// its own Slot's Starter per call.
import { CoreModule, CoreModuleError } from "./wasm";

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

export interface AssetAmount {
  /** Display hex. */
  asset: string;
  /** Base units, as a decimal string (may be negative for `totalLeaving`). */
  amount: string;
}

/** What a module can prove about a request without understanding it. */
export interface VerifiableFacts {
  /** Inputs that re-derive to the Starter's keys: the only ones `sign` signs. */
  ownedInputs: (AssetAmount & { index: number })[];
  /** Per asset: owned inputs minus outputs back to the wallet. */
  totalLeaving: AssetAmount[];
  fee: AssetAmount[];
  /** PSET fields the module doesn't know (kept byte-for-byte when signing). */
  unknownFields: string[];
  /** Risky modes, shown above everything else. */
  dangerousFlags: string[];
}

/** Where an output's funds go. `yours` is decided by re-deriving, never by the requester. */
export type Destination =
  | { kind: "address"; address: string; yours: boolean }
  /** A peg-out burn: `payout` (the burn minus `parentFee`) may be paid on L1 to `l1ScriptPubkey` (hex). */
  | { kind: "pegOut"; l1ScriptPubkey: string; payout: string; parentFee: string };

/** A risky mode of a request, shown above everything else. */
export type DangerousMode =
  | { kind: "nonDefaultSighash"; input: number; sighash: number }
  | { kind: "pegOutBurn"; output: number };

/** What a request the Decoder fully understands does. Data only: `app` renders it. */
export interface ClearView {
  dangerousModes: DangerousMode[];
  inputs: (AssetAmount & { index: number; yours: boolean })[];
  /** Every output except the fee. */
  outputs: (AssetAmount & { index: number; destination: Destination })[];
  fee: AssetAmount;
}

/** `decode`'s answer for a request it doesn't refuse: a Clear View only if fully understood. */
export type Decoded =
  | { kind: "clear"; view: ClearView }
  | { kind: "blind"; reason: string; verifiableFacts: VerifiableFacts };

/** Which rule a module refused a request by. */
export type RefusalCode = "malformed" | "wrongGenesis" | "confidential" | "missingInputFields" | "invalidStarter";

/** A module refused to decode or sign a request. */
export class ChainModuleRefusal extends Error {
  constructor(
    readonly code: RefusalCode,
    message: string,
  ) {
    super(message);
    this.name = "ChainModuleRefusal";
  }
}

export interface ChainModule {
  declare(): Declaration;
  chainEntry(): ChainEntry;
  /** The Slot's Starter → its account, with the first `receive` receive addresses. */
  deriveAccount(starter: string, options: { receive: number }): Account;
  /** A request's payload → a Clear View or Blind. Throws ChainModuleRefusal. */
  decode(payload: string, starter: string): Decoded;
  /** The payload with signatures on the inputs the Starter owns; nothing else changes. Throws ChainModuleRefusal. */
  sign(payload: string, starter: string): string;
}

/** Turns a module's JSON error result into a ChainModuleRefusal. */
function refusals<T>(call: () => T): T {
  try {
    return call();
  } catch (error) {
    if (error instanceof CoreModuleError) {
      let refusal: { code?: RefusalCode; message?: string } | undefined;
      try {
        refusal = JSON.parse(error.message);
      } catch {
        // Not a refusal (e.g. a UTF-8 error); rethrown below.
      }
      if (refusal?.code !== undefined) throw new ChainModuleRefusal(refusal.code, refusal.message ?? refusal.code);
    }
    throw error;
  }
}

export async function loadChainModule(bytes: BufferSource): Promise<ChainModule> {
  const m = await CoreModule.instantiate(bytes);
  const json = <T>(name: string, ...args: (string | number)[]) => JSON.parse(m.callText(name, ...args)) as T;
  return {
    declare: () => json<Declaration>("declare"),
    chainEntry: () => json<ChainEntry>("chain_entry"),
    deriveAccount: (starter, { receive }) => json<Account>("derive_account", starter, receive),
    decode: (payload, starter) => refusals(() => json<Decoded>("decode", payload, starter)),
    sign: (payload, starter) => refusals(() => m.callText("sign", payload, starter)),
  };
}
