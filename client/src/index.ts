// What a Sidechain App uses to find ECX wallets on the page.
//
// Discovery is EIP-6963-style: the app dispatches `ecx:requestProvider` on window, and every
// wallet answers with an `ecx:announceProvider` event carrying `{ info, provider }`. No wallet
// claims a fixed `window.*` name, so several wallets can coexist on one page.

export const REQUEST_PROVIDER_EVENT = "ecx:requestProvider";
export const ANNOUNCE_PROVIDER_EVENT = "ecx:announceProvider";

export interface ProviderInfo {
  /** Random per page load; tells two announcements of the same wallet apart from two wallets. */
  uuid: string;
  name: string;
  /** A data: URI image. */
  icon: string;
  /** Reverse-DNS id of the wallet, stable across page loads. */
  rdns: string;
}

export interface RequestArguments {
  method: string;
  params?: unknown;
}

/** EIP-1193-style error: `code` is 4001 rejected, 4100 unauthorized, 4200 unsupported, 4900/4901 disconnected. */
export interface ProviderRpcError extends Error {
  code: number;
  data?: unknown;
}

export interface Provider {
  request(args: RequestArguments): Promise<unknown>;
}

export interface ProviderDetail {
  info: ProviderInfo;
  provider: Provider;
}

export type AnnounceProviderEvent = CustomEvent<ProviderDetail>;

/** Calls `listener` for every wallet that announces itself, then asks wallets to announce. Returns an unsubscribe function. */
export function onProviderAnnounced(listener: (detail: ProviderDetail) => void): () => void {
  const handler = (event: Event) => listener((event as AnnounceProviderEvent).detail);
  window.addEventListener(ANNOUNCE_PROVIDER_EVENT, handler);
  window.dispatchEvent(new Event(REQUEST_PROVIDER_EVENT));
  return () => window.removeEventListener(ANNOUNCE_PROVIDER_EVENT, handler);
}

/** Collects the wallets that announce themselves within `timeoutMs`, one entry per wallet. */
export function discoverProviders({ timeoutMs = 200 }: { timeoutMs?: number } = {}): Promise<ProviderDetail[]> {
  const found = new Map<string, ProviderDetail>();
  return new Promise((resolve) => {
    const stop = onProviderAnnounced((detail) => {
      if (detail?.info?.uuid && !found.has(detail.info.uuid)) found.set(detail.info.uuid, detail);
    });
    setTimeout(() => {
      stop();
      resolve([...found.values()]);
    }, timeoutMs);
  });
}
