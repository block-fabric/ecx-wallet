// Content script (isolated world). A relay only: it passes the page's Provider requests to the
// background and the answers back, and the background's events to the page. It adds nothing about
// the requester; the background reads the origin from the browser-supplied sender.
import { TO_CONTENT, TO_INPAGE, type GrantChangedMessage, type ProviderResponse, type RelayEvent, type RelayRequest, type RelayResponse } from "./messages";

const DISCONNECTED: ProviderResponse = { ok: false, error: { code: 4900, message: "The wallet is not reachable." } };

window.addEventListener("message", (event: MessageEvent) => {
  const data = event.data as RelayRequest | undefined;
  if (event.source !== window || data?.channel !== TO_CONTENT || typeof data.id !== "string") return;
  chrome.runtime
    .sendMessage({ kind: "provider.request", method: data.method, params: data.params })
    .then((response: ProviderResponse | undefined) => reply(data.id, response ?? DISCONNECTED))
    .catch(() => reply(data.id, DISCONNECTED));
});

function reply(id: string, response: ProviderResponse) {
  const message: RelayResponse = { channel: TO_INPAGE, id, response };
  window.postMessage(message, window.location.origin);
}

// The background tells every tab when any origin's Grant changes: only this page's own goes on.
chrome.runtime.onMessage.addListener((message: GrantChangedMessage, sender) => {
  if (sender.id !== chrome.runtime.id || message?.kind !== "grantChanged" || message.origin !== window.location.origin) return;
  const relayed: RelayEvent = { channel: TO_INPAGE, event: "grantChanged", payload: message.scope };
  window.postMessage(relayed, window.location.origin);
});
