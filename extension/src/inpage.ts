// The injected Provider. Runs in the page's main world at document_start. It holds no state and
// makes no decisions: it announces itself through discovery events and relays each request to
// the content script, then hands back whatever answer comes back.
import {
  ANNOUNCE_PROVIDER_EVENT,
  REQUEST_PROVIDER_EVENT,
  type Provider,
  type ProviderDetail,
  type RequestArguments,
} from "@ecx/client";
import { TO_CONTENT, TO_INPAGE, type RelayRequest, type RelayResponse } from "./messages";

const ICON =
  "data:image/svg+xml;base64," +
  btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="15" fill="#0b6e4f"/></svg>');

const pending = new Map<string, (response: RelayResponse["response"]) => void>();

window.addEventListener("message", (event: MessageEvent) => {
  const data = event.data as RelayResponse | undefined;
  if (event.source !== window || data?.channel !== TO_INPAGE) return;
  const settle = pending.get(data.id);
  if (!settle) return;
  pending.delete(data.id);
  settle(data.response);
});

class ProviderRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

const provider: Provider = Object.freeze({
  request({ method, params }: RequestArguments): Promise<unknown> {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      pending.set(id, (response) =>
        response.ok ? resolve(response.result) : reject(new ProviderRpcError(response.error.code, response.error.message)),
      );
      const message: RelayRequest = { channel: TO_CONTENT, id, method, params };
      window.postMessage(message, window.location.origin);
    });
  },
});

const detail: ProviderDetail = Object.freeze({
  info: Object.freeze({ uuid: crypto.randomUUID(), name: "ECX Wallet", icon: ICON, rdns: "cash.ecx.wallet" }),
  provider,
});

function announce() {
  window.dispatchEvent(new CustomEvent(ANNOUNCE_PROVIDER_EVENT, { detail }));
}

window.addEventListener(REQUEST_PROVIDER_EVENT, announce);
announce();
