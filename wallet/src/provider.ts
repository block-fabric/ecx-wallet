import { ErrorCode, ProviderRpcError } from "./errors";
import type { SlotAddress } from "./accounts";
import { ChainModuleRefusal, type ChainModule, type Decoded } from "./chain-module";
import { covers, GRANTABLE_METHODS, widen, type GrantableMethod, type GrantStore, type Scope } from "./grants";
import { parseSigningRequest, type SigningRequest } from "./signing-request";

/** What the user is asked to approve when an origin connects. */
export interface ConnectPrompt extends Scope {
  /** The requester's web origin as the browser reported it. */
  origin: string;
}

/** The user's answer to a connect prompt. */
export interface ConnectAnswer {
  approved: boolean;
  /** The user ticked the (off-by-default) Blind Signing opt-in. */
  blindSigning: boolean;
}

/** What the approval window shows for a Signing Request. */
export interface SignPrompt {
  /** Who is asking: the browser-reported origin. */
  origin: string;
  chain: string;
  requestId: string;
  /** The Chain Module's view: a Clear View or Blind. */
  decoded: Decoded;
  /** Requester-supplied; shown only tagged "Reported by <origin>". */
  hints?: SigningRequest["hints"];
}

/** One approval window for one Signing Request; it opens on the first thing it has to show. */
export interface SigningApproval {
  /** Asks the user to unlock; true once the wallet is unlocked, false if they close the window. */
  unlock(): Promise<boolean>;
  /** Shows the request; true on approve, false on reject or close. */
  confirm(prompt: SignPrompt): Promise<boolean>;
  /** Closes the window, if open. */
  close(): void;
}

export interface ProviderDeps {
  grants: GrantStore;
  /** Shows the user a connect approval; a dismissed window counts as rejected. */
  askToConnect(prompt: ConnectPrompt): Promise<ConnectAnswer>;
  /** A window for the approval of one Signing Request from `origin` for `chain`. */
  openSigningApproval(context: { origin: string; chain: string }): SigningApproval;
  /** Slots that have a bundled Chain Module. */
  supportedSlots: readonly number[];
  isUnlocked(): Promise<boolean>;
  /** The Slot's receive addresses (only called for a supported Slot while unlocked). */
  receiveAddresses(slot: number): Promise<SlotAddress[]>;
  /** The Slot's Chain Module (only called for a supported Slot). */
  chainModule(slot: number): Promise<ChainModule> | undefined;
  /** The Slot's Starter; throws while locked. */
  starter(slot: number): Promise<string>;
  /** Milliseconds since the epoch. */
  now(): number;
}

const rejected = () => new ProviderRpcError(ErrorCode.UserRejected, "The user rejected the request.");

/**
 * The wallet's side of the Provider: every request from a Sidechain App ends up here, with the
 * origin the browser reported for it. All Grant decisions are made here.
 */
export function createProviderHandler(deps: ProviderDeps) {
  const { grants, askToConnect, supportedSlots, isUnlocked, receiveAddresses } = deps;

  async function connect(origin: string, params: unknown): Promise<Scope> {
    const scope = parseScope(params);
    const existing = await grants.get(origin);
    if (!covers(existing, scope)) {
      const answer = await askToConnect({ origin, ...scope, blindSigning: scope.blindSigning ?? false });
      if (!answer.approved) throw rejected();
      await grants.put(widen(await grants.get(origin), origin, scope, answer.blindSigning));
    }
    const grant = (await grants.get(origin))!;
    return { slots: grant.slots, methods: grant.methods, ...(grant.blindSigning ? { blindSigning: true } : {}) };
  }

  async function granted(origin: string, method: GrantableMethod, params: unknown): Promise<unknown> {
    if (method === "signTransaction") return signTransaction(origin, params);
    const grant = await grants.get(origin);
    if (!grant?.methods.includes(method)) {
      throw new ProviderRpcError(ErrorCode.Unauthorized, `${origin} has no Grant for ${method}; call connect first.`);
    }
    const slot = parseSlot(params);
    if (!grant.slots.includes(slot)) {
      throw new ProviderRpcError(ErrorCode.Unauthorized, `${origin} has no Grant for Slot ${slot}; call connect first.`);
    }
    if (!supportedSlots.includes(slot)) {
      throw new ProviderRpcError(ErrorCode.ChainDisconnected, `This wallet has no Chain Module for Slot ${slot}.`);
    }
    if (!(await isUnlocked())) throw new ProviderRpcError(ErrorCode.Unauthorized, "The wallet is locked.");
    return receiveAddresses(slot);
  }

  /**
   * The spec's validation order: envelope (MAJOR, unknown fields, expiry), then the Grant, then the
   * Slot's Chain Module (genesis, explicit-only, required input fields), then Blind vs the opt-in.
   * The request only ever reaches its own Slot's Chain Module, with that Slot's Starter.
   */
  async function signTransaction(origin: string, params: unknown): Promise<string> {
    const nowSeconds = () => Math.floor(deps.now() / 1000);
    const request = parseSigningRequest(params, nowSeconds());

    // 4. The Grant covers the Slot and the method.
    const grant = await grants.get(origin);
    if (!grant?.methods.includes("signTransaction")) {
      throw new ProviderRpcError(ErrorCode.Unauthorized, `${origin} has no Grant for signTransaction; call connect first.`);
    }
    if (!grant.slots.includes(request.slot)) {
      throw new ProviderRpcError(ErrorCode.Unauthorized, `${origin} has no Grant for Slot ${request.slot}; call connect first.`);
    }
    const pending = supportedSlots.includes(request.slot) ? deps.chainModule(request.slot) : undefined;
    if (pending === undefined) {
      throw new ProviderRpcError(ErrorCode.ChainDisconnected, `This wallet has no Chain Module for Slot ${request.slot}.`);
    }
    const module = await pending;
    const { binding } = module.declare();
    if (binding.chain !== request.chain) {
      throw new ProviderRpcError(ErrorCode.ChainDisconnected, `This wallet's Slot ${request.slot} serves ${binding.chain}, not ${request.chain}.`);
    }
    if (binding.format !== request.format) {
      throw new ProviderRpcError(ErrorCode.UnsupportedMethod, `Unsupported format ${request.format} for ${request.chain}.`);
    }

    const approval = deps.openSigningApproval({ origin, chain: request.chain });
    try {
      if (!(await isUnlocked()) && !(await approval.unlock())) throw rejected();

      // 5-7, then Blind or Clear: the Chain Module decides.
      const decoded = await refusing(async () => module.decode(request.payload, await deps.starter(request.slot)));
      if (decoded.kind === "blind" && !grant.blindSigning) {
        throw new ProviderRpcError(
          ErrorCode.Unauthorized,
          `This request needs Blind Signing, and ${origin}'s Grant doesn't allow Blind Signing.`,
        );
      }
      const prompt: SignPrompt = { origin, chain: request.chain, requestId: request.id, decoded, ...(request.hints ? { hints: request.hints } : {}) };
      if (!(await approval.confirm(prompt))) throw rejected();
      if (request.expiresAt <= nowSeconds()) {
        throw new ProviderRpcError(ErrorCode.InvalidParams, "This Signing Request expired while waiting for approval.");
      }
      return await refusing(async () => module.sign(request.payload, await deps.starter(request.slot)));
    } finally {
      approval.close();
    }
  }

  return async function handle(origin: string, method: unknown, params: unknown): Promise<unknown> {
    if (method === "connect") return connect(origin, params);
    if (method === "disconnect") {
      // Only ever the caller's own Grant: the origin comes from the browser, never from params.
      await grants.remove(origin);
      return null;
    }
    if (isGrantable(method)) return granted(origin, method, params);
    throw new ProviderRpcError(ErrorCode.UnsupportedMethod, `Unsupported method: ${String(method)}`);
  };
}

/** A Chain Module's refusal, as the requester sees it. */
async function refusing<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof ChainModuleRefusal) throw new ProviderRpcError(ErrorCode.InvalidParams, error.message);
    throw error;
  }
}

function isGrantable(method: unknown): method is GrantableMethod {
  return (GRANTABLE_METHODS as readonly unknown[]).includes(method);
}

function isSlot(s: unknown): s is number {
  return Number.isInteger(s) && (s as number) >= 1 && (s as number) <= 255;
}

function parseSlot(params: unknown): number {
  const { slot } = (params ?? {}) as { slot?: unknown };
  if (!isSlot(slot)) throw new ProviderRpcError(ErrorCode.InvalidParams, "getAddresses needs `slot`: a Slot (1-255).");
  return slot;
}

function parseScope(params: unknown): Scope {
  const { slots, methods, blindSigning } = (params ?? {}) as { slots?: unknown; methods?: unknown; blindSigning?: unknown };
  if (
    !Array.isArray(slots) ||
    slots.length === 0 ||
    !slots.every(isSlot)
  ) {
    throw new ProviderRpcError(ErrorCode.InvalidParams, "connect needs `slots`: a non-empty list of Slots (1-255).");
  }
  if (!Array.isArray(methods) || !methods.every((m) => typeof m === "string")) {
    throw new ProviderRpcError(ErrorCode.InvalidParams, "connect needs `methods`: a list of method names.");
  }
  const unsupported = methods.filter((m) => !isGrantable(m));
  if (unsupported.length > 0) {
    throw new ProviderRpcError(ErrorCode.UnsupportedMethod, `Cannot grant unsupported methods: ${unsupported.join(", ")}`);
  }
  return {
    slots: [...new Set(slots as number[])],
    methods: [...new Set(methods as GrantableMethod[])],
    ...(blindSigning === true ? { blindSigning: true } : {}),
  };
}

