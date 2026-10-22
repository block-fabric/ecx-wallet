import { ErrorCode, ProviderRpcError } from "./errors";
import type { SlotAddress } from "./accounts";
import { covers, GRANTABLE_METHODS, scopeOf, widen, type GrantableMethod, type GrantScope, type GrantStore, type Scope } from "./grants";
import { parseSigningRequest } from "./signing-request";
import { chainModuleFor, rejected, reviewAndSign, type SignPrompt, type SigningDeps } from "./signing";
import type { SendResult } from "./pull-path";
import { SidechainServerError, type TransferOrder } from "./sidechain-server";

export type { SignPrompt, SigningApproval } from "./signing";

/** What the user is asked to approve when an origin connects. */
export interface ConnectPrompt extends Scope {
  /** The requester's web origin as the browser reported it. */
  origin: string;
  /** Slots in the scope whose chain is off: approving turns them on. */
  turnsOn?: number[];
}

/** An app asks for chains the user has off: approving turns them on (they stay hidden until then). */
export interface TurnOnPrompt {
  origin: string;
  slots: number[];
}

/** What an approval window shows: a connect prompt, an unlock first, or a Signing Request. */
export type ApprovalPrompt =
  | ({ kind: "connect" } & ConnectPrompt)
  | { kind: "unlock"; origin: string; chain: string }
  | ({ kind: "turnOn" } & TurnOnPrompt)
  | ({ kind: "sign" } & SignPrompt);

/** The user's answer to a connect prompt. */
export interface ConnectAnswer {
  approved: boolean;
  /** The user ticked the (off-by-default) Blind Signing opt-in. */
  blindSigning: boolean;
}

export interface ProviderDeps extends SigningDeps {
  grants: GrantStore;
  /** Shows the user a connect approval; a dismissed window counts as rejected. */
  askToConnect(prompt: ConnectPrompt): Promise<ConnectAnswer>;
  /** The Slot's receive addresses (only called for a supported Slot while unlocked). */
  receiveAddresses(slot: number): Promise<SlotAddress[]>;
  /** Which sidechains the user has on. A request for one that's off turns it on, once they approve. */
  chains: { isOn(slot: number): Promise<boolean>; turnOn(slot: number): Promise<void> };
  /** Asks the user to turn chains on for a request; false if they refuse or close the window. */
  askToTurnOn(prompt: TurnOnPrompt): Promise<boolean>;
  /** The wallet's Send, asked for by `from` (only called for a supported Slot). */
  send(slot: number, order: TransferOrder, from: { origin: string }): Promise<SendResult>;
}

/**
 * The wallet's side of the Provider: every request from a Sidechain App ends up here, with the
 * origin the browser reported for it. All Grant decisions are made here.
 */
export function createProviderHandler(deps: ProviderDeps) {
  const { grants, askToConnect, supportedSlots, isUnlocked, receiveAddresses, chains, askToTurnOn, send } = deps;

  /** The supported Slots among `slots` whose chain is off. */
  async function off(slots: number[]): Promise<number[]> {
    const supported = slots.filter((s) => supportedSlots.includes(s));
    const on = await Promise.all(supported.map((s) => chains.isOn(s)));
    return supported.filter((_, i) => !on[i]);
  }

  /** Before a request reaches a chain that's off: the user approves turning it on, or it's rejected. */
  async function turnOn(origin: string, slots: number[]): Promise<void> {
    const offSlots = await off(slots);
    if (offSlots.length === 0) return;
    if (!(await askToTurnOn({ origin, slots: offSlots }))) throw rejected();
    for (const slot of offSlots) await chains.turnOn(slot);
  }

  async function connect(origin: string, params: unknown): Promise<GrantScope> {
    const scope = parseScope(params);
    const existing = await grants.get(origin);
    if (!covers(existing, scope)) {
      const turnsOn = await off(scope.slots);
      const answer = await askToConnect({ origin, ...scope, ...(turnsOn.length > 0 ? { turnsOn } : {}) });
      if (!answer.approved) throw rejected();
      await grants.put(widen(await grants.get(origin), origin, scope, answer.blindSigning));
      for (const slot of turnsOn) await chains.turnOn(slot);
    } else {
      await turnOn(origin, scope.slots);
    }
    return scopeOf((await grants.get(origin))!);
  }

  /** The caller's own Grant, and whether the wallet is unlocked: no window, no Grant needed. */
  async function getGrant(origin: string): Promise<(GrantScope & { unlocked: boolean }) | null> {
    const grant = await grants.get(origin);
    return grant === undefined ? null : { ...scopeOf(grant), unlocked: await isUnlocked() };
  }

  /** Unlock windows open now, one per origin: further requests from it wait on the same one. */
  const unlocking = new Map<string, Promise<boolean>>();

  /** Asks the user to unlock for `origin`'s request on `slot`, if locked; rejected if they close the window. */
  async function unlocked(origin: string, slot: number): Promise<void> {
    if (await isUnlocked()) return;
    let asking = unlocking.get(origin);
    if (asking === undefined) {
      asking = (async () => {
        try {
          // Another call's window may have unlocked it since this one looked.
          if (await isUnlocked()) return true;
          const chain = (await deps.chainModule(slot)!).declare().binding.chain;
          const approval = deps.openSigningApproval({ origin, chain });
          try {
            return await approval.unlock();
          } finally {
            approval.close();
          }
        } finally {
          unlocking.delete(origin);
        }
      })();
      unlocking.set(origin, asking);
    }
    if (!(await asking)) throw rejected();
  }

  /** The Grant covers `method` on `slot`, and the wallet has the Slot's Chain Module. */
  async function authorize(origin: string, method: GrantableMethod, slot: number): Promise<void> {
    const grant = await grants.get(origin);
    if (!grant?.methods.includes(method)) {
      throw new ProviderRpcError(ErrorCode.Unauthorized, `${origin} has no Grant for ${method}; call connect first.`);
    }
    if (!grant.slots.includes(slot)) {
      throw new ProviderRpcError(ErrorCode.Unauthorized, `${origin} has no Grant for Slot ${slot}; call connect first.`);
    }
    if (!supportedSlots.includes(slot)) {
      throw new ProviderRpcError(ErrorCode.ChainDisconnected, `This wallet has no Chain Module for Slot ${slot}.`);
    }
  }

  async function granted(origin: string, method: GrantableMethod, params: unknown): Promise<unknown> {
    if (method === "signTransaction") return signTransaction(origin, params);
    if (method === "sendTransfer") return sendTransfer(origin, params);
    const slot = parseSlot(method, params);
    await authorize(origin, method, slot);
    await unlocked(origin, slot);
    await turnOn(origin, [slot]);
    return receiveAddresses(slot);
  }

  /**
   * The wallet's own Send, for an app (#39, docs/adr/0006): the app names the outputs, the wallet
   * picks the coins and change, the user approves it Clear (never Blind), and the wallet broadcasts
   * it and holds its coins. Works while locked: the approval window unlocks first.
   */
  async function sendTransfer(origin: string, params: unknown): Promise<{ txid?: string }> {
    const slot = parseSlot("sendTransfer", params);
    await authorize(origin, "sendTransfer", slot);
    await turnOn(origin, [slot]);
    const { outputs } = params as { outputs?: unknown };
    const result = await send(slot, { outputs: outputs as TransferOrder["outputs"] }, { origin });
    if (!result.accepted) throw new SidechainServerError(result.server, `The Sidechain Server at ${result.server} didn't accept the transaction.`);
    return result.txid === undefined ? {} : { txid: result.txid };
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
    const module = await chainModuleFor(deps, request);
    await turnOn(origin, [request.slot]);

    // 5-7, then Blind (only with the Grant's opt-in) or Clear, approval and signing.
    return reviewAndSign(deps, {
      requester: origin,
      request,
      module,
      ...(grant.blindSigning
        ? {}
        : { blindRefusal: `This request needs Blind Signing, and ${origin}'s Grant doesn't allow Blind Signing.` }),
    });
  }

  return async function handle(origin: string, method: unknown, params: unknown): Promise<unknown> {
    if (method === "connect") return connect(origin, params);
    if (method === "getGrant") return getGrant(origin);
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

function parseSlot(method: string, params: unknown): number {
  const { slot } = (params ?? {}) as { slot?: unknown };
  if (!isSlot(slot)) throw new ProviderRpcError(ErrorCode.InvalidParams, `${method} needs \`slot\`: a Slot (1-255).`);
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
  return {
    slots: [...new Set(slots as number[])],
    methods: [...new Set(methods as GrantableMethod[])],
  };
}

