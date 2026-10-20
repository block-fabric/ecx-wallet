// Background: Chromium service worker / Firefox background script.
//
// MV3 rules this file must keep:
// - every listener is registered synchronously at top level;
// - no top-level await; WASM is fetched and instantiated lazily inside handlers.
import {
  createAccounts,
  createChainModules,
  createProviderHandler,
  SUPPORTED_SLOTS,
  createVault,
  ErrorCode,
  loadVaultModule,
  ProviderRpcError,
  VaultError,
  type ConnectPrompt,
  type Grant,
  type GrantStore,
  type KeyValueStore,
  type VaultModule,
} from "@ecx/wallet";
import type { BackgroundMessage, ProviderResponse } from "./messages";

/** Error code for Vault failures reported to the wallet's own pages (wrong password, ...). */
const VAULT_ERROR = -32000;
const AUTO_LOCK_ALARM = "vault:auto-lock";

function keyValueStore(area: chrome.storage.StorageArea): KeyValueStore {
  return {
    get: async <T>(key: string) => (await area.get(key))[key] as T | undefined,
    set: (key, value) => area.set({ [key]: value }),
    remove: (key) => area.remove(key),
  };
}

/** A shipped .wasm's bytes, from the extension package. */
const fetchWasm = (file: string) => fetch(chrome.runtime.getURL(file)).then((response) => response.arrayBuffer());

let vaultModule: Promise<VaultModule> | undefined;
/** vault.wasm, instantiated on first use (and again after each worker restart). */
function loadVault(): Promise<VaultModule> {
  vaultModule ??= fetchWasm("vault.wasm")
    .then(loadVaultModule)
    .catch((error) => {
      vaultModule = undefined;
      throw error;
    });
  return vaultModule;
}

/**
 * The Vault. Its unlock state lives in `storage.session` (memory-only, cleared on browser close,
 * not exposed to content scripts), so it survives this worker being stopped and restarted.
 */
const vault = createVault({
  module: loadVault,
  persistent: keyValueStore(chrome.storage.local),
  session: keyValueStore(chrome.storage.session),
  random: (length) => crypto.getRandomValues(new Uint8Array(length)),
  now: () => Date.now(),
  onDeadline: (deadline) => {
    if (deadline === null) chrome.alarms.clear(AUTO_LOCK_ALARM).catch(() => {});
    else chrome.alarms.create(AUTO_LOCK_ALARM, { when: deadline }).catch(() => {});
  },
});

// The deadline is also enforced on every use; the alarm clears the key even if nothing asks.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_LOCK_ALARM) vault.checkAutoLock().catch(console.error);
});

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

// Each Slot's Chain Module runs in its own WASM instance (instantiated on first use) and gets
// only that Slot's Starter, per call.
const accounts = createAccounts({ starter: (slot) => vault.starter(slot), chainModule: createChainModules(fetchWasm) });

const handleProviderRequest = createProviderHandler({
  grants,
  askToConnect,
  supportedSlots: SUPPORTED_SLOTS,
  isUnlocked: async () => (await vault.status()).unlocked,
  receiveAddresses: (slot) => accounts.receiveAddresses(slot),
});

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
    case "accounts.list":
      if (!fromWalletPage(sender)) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
      // One entry per Slot with a Chain Module; addresses are public, so the page may show them.
      return Promise.all(
        SUPPORTED_SLOTS.map(async (slot) => ({ slot, addresses: await accounts.receiveAddresses(slot) })),
      );
    case "vault.status":
    case "vault.generate":
    case "vault.create":
    case "vault.unlock":
    case "vault.lock":
    case "vault.setAutoLock":
      if (!fromWalletPage(sender)) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
      return routeVault(message);
    default:
      throw new ProviderRpcError(ErrorCode.UnsupportedMethod, "Unknown message.");
  }
}

/** Vault requests from the wallet's own pages. Replies carry status only, never secrets. */
async function routeVault(message: Extract<BackgroundMessage, { kind: `vault.${string}` }>): Promise<unknown> {
  switch (message.kind) {
    case "vault.status":
      return vault.status();
    case "vault.generate":
      // The one time a Master Mnemonic leaves the background: to be shown for backup at creation.
      return { masterMnemonic: await vault.generate() };
    case "vault.create":
      await vault.create({
        masterMnemonic: String(message.masterMnemonic ?? ""),
        passphrase: String(message.passphrase ?? ""),
        password: String(message.password ?? ""),
      });
      return vault.status();
    case "vault.unlock":
      await vault.unlock(String(message.password ?? ""));
      return vault.status();
    case "vault.lock":
      await vault.lock();
      return vault.status();
    case "vault.setAutoLock":
      await vault.setAutoLockMinutes(Number(message.minutes));
      return null;
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
  if (error instanceof VaultError) return { ok: false, error: { code: VAULT_ERROR, message: error.message } };
  console.error(error);
  return { ok: false, error: { code: ErrorCode.Internal, message: "Internal wallet error." } };
}
