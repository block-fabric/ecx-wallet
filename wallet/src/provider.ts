import { ErrorCode, ProviderRpcError } from "./errors";
import type { SlotAddress } from "./accounts";
import { covers, GRANTABLE_METHODS, widen, type GrantableMethod, type GrantStore, type Scope } from "./grants";

/** What the user is asked to approve when an origin connects. */
export interface ConnectPrompt extends Scope {
  /** The requester's web origin as the browser reported it. */
  origin: string;
}

export interface ProviderDeps {
  grants: GrantStore;
  /** Shows the user a connect approval; resolves true on approve, false on reject or dismiss. */
  askToConnect(prompt: ConnectPrompt): Promise<boolean>;
  /** Slots that have a bundled Chain Module. */
  supportedSlots: readonly number[];
  isUnlocked(): Promise<boolean>;
  /** The Slot's receive addresses (only called for a supported Slot while unlocked). */
  receiveAddresses(slot: number): Promise<SlotAddress[]>;
}

/**
 * The wallet's side of the Provider: every request from a Sidechain App ends up here, with the
 * origin the browser reported for it. All Grant decisions are made here.
 */
export function createProviderHandler({ grants, askToConnect, supportedSlots, isUnlocked, receiveAddresses }: ProviderDeps) {
  async function connect(origin: string, params: unknown): Promise<Scope> {
    const scope = parseScope(params);
    const existing = await grants.get(origin);
    if (!covers(existing, scope)) {
      if (!(await askToConnect({ origin, ...scope }))) {
        throw new ProviderRpcError(ErrorCode.UserRejected, "The user rejected the request.");
      }
      await grants.put(widen(await grants.get(origin), origin, scope));
    }
    const grant = (await grants.get(origin))!;
    return { slots: grant.slots, methods: grant.methods };
  }

  async function granted(origin: string, method: GrantableMethod, params: unknown): Promise<unknown> {
    const grant = await grants.get(origin);
    if (!grant?.methods.includes(method)) {
      throw new ProviderRpcError(ErrorCode.Unauthorized, `${origin} has no Grant for ${method}; call connect first.`);
    }
    if (method === "getAddresses") {
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
    // Provisional: signTransaction lands in a later ticket (#22 onwards).
    throw new ProviderRpcError(ErrorCode.UnsupportedMethod, `${method} is not available in this build yet.`);
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
  const { slots, methods } = (params ?? {}) as { slots?: unknown; methods?: unknown };
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
  return { slots: [...new Set(slots as number[])], methods: [...new Set(methods as GrantableMethod[])] };
}
