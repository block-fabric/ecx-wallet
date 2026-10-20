// The app's only channel to the wallet: messages to the extension background, which holds every
// secret and makes every decision. The app renders what it is given and reports the user's choice.

export interface ConnectPrompt {
  kind: "connect";
  origin: string;
  slots: number[];
  methods: string[];
}

/** A Signing Request arrived while locked: unlock first, in the approval window. */
export interface UnlockPrompt {
  kind: "unlock";
  origin: string;
  chain: string;
}

export interface AssetAmount {
  asset: string;
  amount: string;
}

/** What the Chain Module can prove about a request it can't explain. */
export interface VerifiableFacts {
  ownedInputs: (AssetAmount & { index: number })[];
  totalLeaving: AssetAmount[];
  fee: AssetAmount[];
  unknownFields: string[];
  dangerousFlags: string[];
}

export type Destination =
  | { kind: "address"; address: string; yours: boolean }
  | { kind: "withdrawal"; l1Address?: string; l1ScriptPubkey: string; payout: string; parentFee: string };

export type DangerousMode = { kind: "nonDefaultSighash"; input: number; sighash: number } | { kind: "withdrawalBurn"; output: number };

/** What a request the Chain Module fully understands does. */
export interface ClearView {
  dangerousModes: DangerousMode[];
  inputs: (AssetAmount & { index: number; yours: boolean })[];
  outputs: (AssetAmount & { index: number; destination: Destination })[];
  fee: AssetAmount;
}

export type Decoded = { kind: "clear"; view: ClearView } | { kind: "blind"; reason: string; verifiableFacts: VerifiableFacts };

export interface SignPrompt {
  kind: "sign";
  origin: string;
  chain: string;
  requestId: string;
  decoded: Decoded;
  hints?: { summary?: string; outputLabels?: Record<string, string> };
}

export type ApprovalPrompt = ConnectPrompt | UnlockPrompt | SignPrompt;

type Response<T> = { ok: true; result: T } | { ok: false; error: { code: number; message: string } };

async function send<T>(message: unknown): Promise<T> {
  const response = (await chrome.runtime.sendMessage(message)) as Response<T>;
  if (!response.ok) throw new Error(response.error.message);
  return response.result;
}

/** The approval's current prompt; waits while the background prepares it. Null once it's over. */
export const getApproval = (id: string) => send<ApprovalPrompt | null>({ kind: "approval.get", id });

export const resolveApproval = (id: string, approved: boolean, options: { blindSigning?: boolean } = {}) =>
  send<null>({ kind: "approval.resolve", id, approved, ...options });

/** Unlocks the wallet from an approval window; throws on a wrong password. */
export const unlockApproval = (id: string, password: string) => send<null>({ kind: "approval.unlock", id, password });

export interface VaultStatus {
  exists: boolean;
  unlocked: boolean;
}

export const vaultStatus = () => send<VaultStatus>({ kind: "vault.status" });

/** A fresh Master Mnemonic to show once for backup; nothing is stored until `createVault`. */
export const generateMnemonic = async () =>
  (await send<{ masterMnemonic: string }>({ kind: "vault.generate" })).masterMnemonic;

/** Stores the (new or imported) Master Mnemonic encrypted under `password`; leaves it unlocked. */
export const createVault = (args: { masterMnemonic: string; passphrase?: string; password: string }) =>
  send<VaultStatus>({ kind: "vault.create", ...args });

export const unlockVault = (password: string) => send<VaultStatus>({ kind: "vault.unlock", password });

export const lockVault = () => send<VaultStatus>({ kind: "vault.lock" });

/** Passwords shorter than this are refused (the background enforces it too). */
export const MIN_PASSWORD_LENGTH = 8;

/** Checks a new password and its repetition; returns an error message or "". */
export function checkNewPassword(password: string, repeat: string): string {
  if (password.length < MIN_PASSWORD_LENGTH) return `The password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password !== repeat) return "The passwords don't match.";
  return "";
}

/** One Slot's account: its receive address(es) in the chain's own encoding. */
export interface SlotAccount {
  slot: number;
  addresses: { chain: string; address: string }[];
}

/** Every Slot the wallet has a Chain Module for (needs the wallet unlocked). */
export const listAccounts = () => send<SlotAccount[]>({ kind: "accounts.list" });

/** A Slot's balance per asset as its Sidechain Server (`server`) reports it; the wallet doesn't verify it. */
export interface SlotReport {
  slot: number;
  chain: string;
  server: string;
  balances: AssetAmount[];
  history: unknown[];
}

/** Registers the Slot's addresses with its Sidechain Server and returns what the server reports. */
export const reportedState = (slot: number) => send<SlotReport>({ kind: "accounts.reported", slot });

export interface SendResult {
  requestId: string;
  server: string;
  accepted: boolean;
  txid?: string;
}

/**
 * Sends from the wallet's own Send screen: the Slot's Sidechain Server builds the transfer, the user
 * reviews it in an approval window, the wallet signs and submits it. Throws on refusal or rejection.
 */
export const startSend = (order: { slot: number; asset: string; amount: string; destination: string }) =>
  send<SendResult>({ kind: "send.start", ...order });

/** A stored Grant as the Grants screen shows it. */
export interface Grant {
  origin: string;
  slots: number[];
  methods: string[];
  blindSigning: boolean;
}

export const listGrants = () => send<Grant[]>({ kind: "grants.list" });

export const revokeGrant = (origin: string) => send<null>({ kind: "grants.revoke", origin });
