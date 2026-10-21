// Background: Chromium service worker / Firefox background script.
//
// MV3 rules this file must keep:
// - every listener is registered synchronously at top level;
// - no top-level await; WASM is fetched and instantiated lazily inside handlers.
import {
  CACHE_PREFIX,
  createAccounts,
  createChainModules,
  createDeposits,
  esploraClient,
  createL1Module,
  createProviderHandler,
  createPullPath,
  createSettings,
  describeChain,
  sidechainServer,
  SidechainServerError,
  SUPPORTED_SLOTS,
  createVault,
  ErrorCode,
  loadVaultModule,
  ProviderRpcError,
  VaultError,
  type ApprovalPrompt,
  type ConnectAnswer,
  type ConnectPrompt,
  type DepositStore,
  type Grant,
  type GrantStore,
  type KeyValueStore,
  type PendingDeposit,
  type SessionCache,
  type SigningApproval,
  type VaultModule,
} from "@ecx/wallet";
import type { BackgroundMessage, ProviderResponse } from "./messages";

/** Error code for Vault failures reported to the wallet's own pages (wrong password, ...). */
const VAULT_ERROR = -32000;
/** Error code for a Sidechain Server that couldn't be reached or refused, reported to the wallet's own pages. */
const SIDECHAIN_SERVER_ERROR = -32001;
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
  onDeadline: async (deadline) => {
    if (deadline === null) {
      chrome.alarms.clear(AUTO_LOCK_ALARM).catch(() => {});
      // Awaited: once locked, nothing kept for the session is left.
      await forgetSessionCache().catch(console.error);
    } else chrome.alarms.create(AUTO_LOCK_ALARM, { when: deadline }).catch(() => {});
  },
});

/**
 * What the wallet keeps for the session to answer faster: passed identity checks, the last
 * reported balances, raw transactions (wallet/src/cache.ts). In `storage.session`, so never on
 * disk; read and written only while unlocked, and forgotten on lock.
 */
const sessionCache: SessionCache = {
  async get<T>(key: string) {
    if (!(await vault.status()).unlocked) return undefined;
    return (await chrome.storage.session.get(key))[key] as T | undefined;
  },
  async set(key, value) {
    if ((await vault.status()).unlocked) await chrome.storage.session.set({ [key]: value });
  },
};

async function forgetSessionCache(): Promise<void> {
  const all = await chrome.storage.session.get(null);
  await chrome.storage.session.remove(Object.keys(all).filter((key) => key.startsWith(CACHE_PREFIX)));
}

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

// Deposits the wallet broadcast and still watches, until credited or dismissed.
const DEPOSIT_PREFIX = "deposit:";

const depositStore: DepositStore = {
  async list() {
    const all = await chrome.storage.local.get(null);
    return Object.entries(all)
      .filter(([key]) => key.startsWith(DEPOSIT_PREFIX))
      .map(([, deposit]) => deposit as PendingDeposit);
  },
  async put(deposit) {
    await chrome.storage.local.set({ [`${DEPOSIT_PREFIX}${deposit.txid}`]: deposit });
  },
  async remove(txid) {
    await chrome.storage.local.remove(`${DEPOSIT_PREFIX}${txid}`);
  },
};

// Approval windows. Their state lives in memory. Provisional: if the worker is stopped while an
// approval window is open, the request is lost and the page gets 4900 from the content script.

/** The user's answer; null when the window was closed. */
type ApprovalAnswer = { approved: boolean; blindSigning?: boolean } | null;

/**
 * One window that can ask several questions in turn (unlock, then approve). The page asks for the
 * current prompt (`approval.get`), which waits while the background prepares the next one.
 */
class ApprovalWindow {
  readonly id = crypto.randomUUID();
  windowId?: number;
  private opened = false;
  private closed = false;
  private current = deferred<ApprovalPrompt | null>();
  private answer?: (answer: ApprovalAnswer) => void;

  /** The prompt the page should show now (waits while the next one is being prepared). */
  prompt(): Promise<ApprovalPrompt | null> {
    return this.current.promise;
  }

  /** Shows `prompt` (opening the window on first use) and resolves with the user's answer. */
  ask(prompt: ApprovalPrompt): Promise<ApprovalAnswer> {
    if (this.closed) return Promise.resolve(null);
    const answered = new Promise<ApprovalAnswer>((resolve) => (this.answer = resolve));
    this.current.resolve(prompt);
    if (!this.opened) this.open();
    return answered;
  }

  /** Records the user's answer; the page then waits for the next prompt, if any. */
  settle(answer: ApprovalAnswer): void {
    const resolve = this.answer;
    this.answer = undefined;
    this.current = deferred();
    resolve?.(answer);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    approvals.delete(this.id);
    this.settle(null);
    this.current.resolve(null);
    if (this.windowId !== undefined) chrome.windows.remove(this.windowId).catch(() => {});
  }

  private open(): void {
    this.opened = true;
    approvals.set(this.id, this);
    chrome.windows
      .create({ url: chrome.runtime.getURL(`index.html#/approve/${this.id}`), type: "popup", width: 420, height: 640 })
      .then((window) => {
        this.windowId = window?.id;
        if (this.closed && window?.id !== undefined) chrome.windows.remove(window.id).catch(() => {});
      }, () => this.close());
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const approvals = new Map<string, ApprovalWindow>();

async function askToConnect(prompt: ConnectPrompt): Promise<ConnectAnswer> {
  const approval = new ApprovalWindow();
  try {
    const answer = await approval.ask({ kind: "connect", ...prompt });
    return { approved: answer?.approved === true, blindSigning: answer?.approved === true && answer.blindSigning === true };
  } finally {
    approval.close();
  }
}

function openSigningApproval(context: { origin: string; chain: string }): SigningApproval {
  const approval = new ApprovalWindow();
  return {
    unlock: async () => (await approval.ask({ kind: "unlock", ...context }))?.approved === true,
    confirm: async (prompt) => (await approval.ask({ kind: "sign", ...prompt }))?.approved === true,
    close: () => approval.close(),
  };
}

// Closing the approval window counts as rejecting.
chrome.windows.onRemoved.addListener((windowId) => {
  for (const approval of approvals.values()) if (approval.windowId === windowId) approval.close();
});

// Each Chain Module runs in its own WASM instance (instantiated on first use) and gets only its
// own key, per call: a Slot's module that Slot's Starter, eCash's module the L1 Account Key.
const chainModule = createChainModules(fetchWasm);
const l1Module = createL1Module(fetchWasm);
const keys = { starter: (slot: number) => vault.starter(slot), l1AccountKey: () => vault.l1AccountKey() };
const accounts = createAccounts({ ...keys, chainModule, l1Module });
const settings = createSettings(keyValueStore(chrome.storage.local));

/** One review for every Signing Request, whichever path it came by. */
const signing = {
  openSigningApproval,
  supportedSlots: SUPPORTED_SLOTS,
  isUnlocked: async () => (await vault.status()).unlocked,
  chainModule,
  starter: keys.starter,
  now: () => Date.now(),
};

const handleProviderRequest = createProviderHandler({
  ...signing,
  grants,
  askToConnect,
  receiveAddresses: (slot) => accounts.receiveAddresses(slot),
});

// The pull path: each Slot's Sidechain Server, in the Server API its Chain Entry names.
const pullPath = createPullPath({
  ...signing,
  ...keys,
  l1Module,
  sidechainServer: (entry, network) => sidechainServer(entry, network, undefined, sessionCache),
  cache: sessionCache,
});

// Deposits: the L1 module builds the M5 from the wallet's own coins, over eCash's Esplora.
const deposits = createDeposits({
  ...keys,
  chainModule,
  l1Module,
  openSigningApproval,
  isUnlocked: signing.isUnlocked,
  esplora: (entry, network) =>
    esploraClient(
      { url: network.sidechainServer.url, identityBlock: network.identityBlock, chainName: entry.name, cache: sessionCache },
      (...args) => fetch(...args),
    ),
  store: depositStore,
  cache: sessionCache,
  now: () => Date.now(),
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

/** A wallet page's `slot`, if the wallet has a Chain Module for it. */
function supportedSlot(slot: unknown): number {
  const n = Number(slot);
  if (!SUPPORTED_SLOTS.includes(n)) throw new ProviderRpcError(ErrorCode.ChainDisconnected, "No Chain Module for that Slot.");
  return n;
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
      return (await approvals.get(message.id)?.prompt()) ?? null;
    case "approval.resolve":
      if (!fromWalletPage(sender)) return null;
      approvals.get(message.id)?.settle({ approved: message.approved === true, blindSigning: message.blindSigning === true });
      return null;
    case "approval.unlock": {
      // Unlocking from an approval window: throws (wrong password) without answering the prompt.
      if (!fromWalletPage(sender)) return null;
      const approval = approvals.get(message.id);
      if (approval === undefined) return null;
      await vault.unlock(String(message.password ?? ""));
      approval.settle({ approved: true });
      return null;
    }
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
    case "chains.list":
      // Public: what the Chain Entries say, so the page can name chains and assets even while locked.
      if (!fromWalletPage(sender)) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
      return [
        { id: "l1", ...describeChain(await l1Module()) },
        ...(await Promise.all(SUPPORTED_SLOTS.map(async (slot) => ({ id: slot, ...describeChain(await chainModule(slot)!) })))),
      ];
    case "settings.unit":
      if (!fromWalletPage(sender)) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
      return settings.unit();
    case "settings.setUnit":
      if (!fromWalletPage(sender)) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
      await settings.setUnit(String(message.unit ?? ""));
      return settings.unit();
    case "l1.account":
      // eCash's own account: its receive address and what its server reports are asked separately.
      if (!fromWalletPage(sender)) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
      return { addresses: await accounts.l1ReceiveAddresses() };
    case "l1.reported":
      if (!fromWalletPage(sender)) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
      return pullPath.reportedL1State();
    case "l1.cached":
      // The last report this session, shown while `l1.reported` refreshes it; null if none.
      if (!fromWalletPage(sender)) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
      return (await pullPath.cachedL1State()) ?? null;
    case "accounts.cached":
      if (!fromWalletPage(sender)) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
      return (await pullPath.cachedState(supportedSlot(message.slot))) ?? null;
    case "accounts.reported":
      // What a Slot's Sidechain Server reports for the addresses the wallet watches.
      if (!fromWalletPage(sender)) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
      return pullPath.reportedState(supportedSlot(message.slot));
    case "history.reported":
      if (!fromWalletPage(sender)) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
      return message.slot === undefined ? pullPath.l1History() : pullPath.history(supportedSlot(message.slot));
    case "history.cached":
      if (!fromWalletPage(sender)) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
      return (await (message.slot === undefined ? pullPath.cachedL1History() : pullPath.cachedHistory(supportedSlot(message.slot)))) ?? null;
    case "send.start":
      // The wallet's own Send: resolves once the server accepted the signed payload.
      if (!fromWalletPage(sender)) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
      return pullPath.send(supportedSlot(message.slot), {
        asset: String(message.asset ?? ""),
        amount: String(message.amount ?? ""),
        destination: String(message.destination ?? ""),
      });
    case "deposit.start":
      // Resolves once the M5 is broadcast (after the user's approval).
      if (!fromWalletPage(sender)) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
      return deposits.start(supportedSlot(message.slot), String(message.amount ?? ""));
    case "deposit.list":
      if (!fromWalletPage(sender)) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
      return deposits.list(supportedSlot(message.slot));
    case "deposit.dismiss":
      if (!fromWalletPage(sender)) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
      await deposits.dismiss(String(message.txid ?? ""));
      return null;
    case "deposit.refused":
      // The Slot's last Deposit that failed after approval, for the home page: its page may be gone.
      if (!fromWalletPage(sender)) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
      return (await deposits.refused(supportedSlot(message.slot))) ?? null;
    case "deposit.dismissRefused":
      if (!fromWalletPage(sender)) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
      await deposits.dismissRefused(supportedSlot(message.slot));
      return null;
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
  if (error instanceof SidechainServerError) return { ok: false, error: { code: SIDECHAIN_SERVER_ERROR, message: error.message } };
  console.error(error);
  return { ok: false, error: { code: ErrorCode.Internal, message: "Internal wallet error." } };
}
