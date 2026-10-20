// Content script (isolated world). A relay only: it passes the page's Provider requests to the
// background and the answers back. It adds nothing about the requester; the background reads the
// origin from the browser-supplied sender.
import { TO_CONTENT, TO_INPAGE, type ProviderResponse, type RelayRequest, type RelayResponse } from "./messages";

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
