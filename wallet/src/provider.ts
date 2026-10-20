import { ErrorCode, ProviderRpcError } from "./errors";
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
}

/**
 * The wallet's side of the Provider: every request from a Sidechain App ends up here, with the
 * origin the browser reported for it. All Grant decisions are made here.
 */
export function createProviderHandler({ grants, askToConnect }: ProviderDeps) {
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

  async function granted(origin: string, method: GrantableMethod): Promise<never> {
    const grant = await grants.get(origin);
    if (!grant?.methods.includes(method)) {
      throw new ProviderRpcError(ErrorCode.Unauthorized, `${origin} has no Grant for ${method}; call connect first.`);
    }
    // Provisional: getAddresses and signTransaction land in later tickets (#20 onwards).
    throw new ProviderRpcError(ErrorCode.UnsupportedMethod, `${method} is not available in this build yet.`);
  }

  return async function handle(origin: string, method: unknown, params: unknown): Promise<unknown> {
    if (method === "connect") return connect(origin, params);
    if (method === "disconnect") {
      // Only ever the caller's own Grant: the origin comes from the browser, never from params.
      await grants.remove(origin);
      return null;
    }
    if (isGrantable(method)) return granted(origin, method);
    throw new ProviderRpcError(ErrorCode.UnsupportedMethod, `Unsupported method: ${String(method)}`);
  };
}

function isGrantable(method: unknown): method is GrantableMethod {
  return (GRANTABLE_METHODS as readonly unknown[]).includes(method);
}

function parseScope(params: unknown): Scope {
  const { slots, methods } = (params ?? {}) as { slots?: unknown; methods?: unknown };
  if (
    !Array.isArray(slots) ||
    slots.length === 0 ||
    !slots.every((s) => Number.isInteger(s) && s >= 1 && s <= 255)
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
