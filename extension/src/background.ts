// Background: Chromium service worker / Firefox background script.
//
// MV3 rules this file must keep (they matter once WASM lands):
// - every listener is registered synchronously at top level;
// - no top-level await; WASM init() will run lazily inside handlers.
import {
  createProviderHandler,
  ErrorCode,
  ProviderRpcError,
  type ConnectPrompt,
  type Grant,
  type GrantStore,
} from "@ecx/wallet";
import type { BackgroundMessage, ProviderResponse } from "./messages";

const GRANT_PREFIX = "grant:";
const grantKey = (origin: string) => `${GRANT_PREFIX}${origin}`;

const grants: GrantStore = {
  async get(origin) {
    const key = grantKey(origin);
    return (await chrome.storage.local.get(key))[key] as Grant | undefined;
  },
  async put(grant) {
    await chrome.storage.local.set({ [grantKey(grant.origin)]: grant });
  },
  async remove(origin) {
    await chrome.storage.local.remove(grantKey(origin));
  },
  async list() {
    const all = await chrome.storage.local.get(null);
    return Object.entries(all)
      .filter(([key]) => key.startsWith(GRANT_PREFIX))
      .map(([, grant]) => grant as Grant);
  },
};

// Pending approvals live in memory. Provisional: if the worker is stopped while an approval
// window is open, the request is lost and the page gets 4900 from the content script.
interface PendingApproval {
  prompt: ConnectPrompt;
  settle: (approved: boolean) => void;
  windowId?: number;
}
const approvals = new Map<string, PendingApproval>();

function askToConnect(prompt: ConnectPrompt): Promise<boolean> {
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    const pending: PendingApproval = {
      prompt,
      settle: (approved) => {
        approvals.delete(id);
        if (pending.windowId !== undefined) chrome.windows.remove(pending.windowId).catch(() => {});
        resolve(approved);
      },
    };
    approvals.set(id, pending);
    chrome.windows
      .create({ url: chrome.runtime.getURL(`index.html#/approve/${id}`), type: "popup", width: 420, height: 600 })
      .then((window) => {
        pending.windowId = window?.id;
        if (!approvals.has(id) && window?.id !== undefined) chrome.windows.remove(window.id).catch(() => {});
      }, () => pending.settle(false));
  });
}

// Closing the approval window counts as rejecting.
chrome.windows.onRemoved.addListener((windowId) => {
  for (const pending of approvals.values()) if (pending.windowId === windowId) pending.settle(false);
});

const handleProviderRequest = createProviderHandler({ grants, askToConnect });

/** The requester's web origin as the browser reports it for a content-script message. */
function requesterOrigin(sender: chrome.runtime.MessageSender): string | undefined {
  if (sender.id !== chrome.runtime.id || sender.tab === undefined || sender.frameId !== 0) return undefined;
  const origin = sender.origin ?? (sender.url ? new URL(sender.url).origin : undefined);
  return origin?.startsWith("https://") || origin?.startsWith("http://") ? origin : undefined;
}

/** True for messages from the wallet's own pages (e.g. the approval window), never from web pages. */
function fromWalletPage(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && (sender.url?.startsWith(chrome.runtime.getURL("")) ?? false);
}

async function route(message: BackgroundMessage, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (message?.kind) {
    case "provider.request": {
      const origin = requesterOrigin(sender);
      if (origin === undefined) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
      return handleProviderRequest(origin, message.method, message.params);
    }
    case "approval.get":
      if (!fromWalletPage(sender)) return null;
      return approvals.get(message.id)?.prompt ?? null;
    case "approval.resolve":
      if (!fromWalletPage(sender)) return null;
      approvals.get(message.id)?.settle(message.approved === true);
      return null;
    case "grants.list":
      if (!fromWalletPage(sender)) return null;
      return (await grants.list()).sort((a, b) => a.origin.localeCompare(b.origin));
    case "grants.revoke":
      if (!fromWalletPage(sender)) return null;
      if (typeof message.origin === "string") await grants.remove(message.origin);
      return null;
    default:
      throw new ProviderRpcError(ErrorCode.UnsupportedMethod, "Unknown message.");
  }
}

chrome.runtime.onMessage.addListener((message: BackgroundMessage, sender, sendResponse) => {
  route(message, sender).then(
    (result): void => sendResponse({ ok: true, result } satisfies ProviderResponse),
    (error): void => sendResponse(toErrorResponse(error)),
  );
  return true; // respond asynchronously
});

function toErrorResponse(error: unknown): ProviderResponse {
  if (error instanceof ProviderRpcError) return { ok: false, error: { code: error.code, message: error.message } };
  console.error(error);
  return { ok: false, error: { code: ErrorCode.Internal, message: "Internal wallet error." } };
}
