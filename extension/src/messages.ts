// Message shapes between the extension's contexts.
//
//   page (inpage.ts, main world) --window.postMessage--> content.ts (isolated world)
//     --runtime.sendMessage--> background.ts --> wallet's Provider handler
//
// The inpage Provider and the content script only relay. The background derives the requester's
// origin from the browser-supplied `sender`, never from anything inside the message.

/** window.postMessage channel tags, so the two sides ignore everything else on the page. */
export const TO_CONTENT = "ecx:to-content";
export const TO_INPAGE = "ecx:to-inpage";

export type ProviderResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: number; message: string } };

export interface RelayRequest {
  channel: typeof TO_CONTENT;
  id: string;
  method: unknown;
  params: unknown;
}

export interface RelayResponse {
  channel: typeof TO_INPAGE;
  id: string;
  response: ProviderResponse;
}

/** runtime messages handled by the background. */
export type BackgroundMessage =
  | { kind: "provider.request"; method: unknown; params: unknown }
  | { kind: "approval.get"; id: string }
  | { kind: "approval.resolve"; id: string; approved: boolean; blindSigning?: boolean }
  // Unlock from an approval window (a Signing Request that arrived while locked).
  | { kind: "approval.unlock"; id: string; password: string }
  | { kind: "grants.list" }
  | { kind: "grants.revoke"; origin: string }
  // Accounts (receive addresses per Slot): accepted only from the wallet's own pages.
  | { kind: "accounts.list" }
  // Pull path (registers the Slot's addresses, then its server's reported state): wallet pages only.
  | { kind: "accounts.reported"; slot: number }
  // The wallet's own Send (pull path): wallet pages only.
  | { kind: "send.start"; slot: number; asset: string; amount: string; destination: string }
  // Vault: accepted only from the wallet's own pages.
  | { kind: "vault.status" }
  | { kind: "vault.generate" }
  | { kind: "vault.create"; masterMnemonic: string; passphrase?: string; password: string }
  | { kind: "vault.unlock"; password: string }
  | { kind: "vault.lock" }
  | { kind: "vault.setAutoLock"; minutes: number };
