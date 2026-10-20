// The app's only channel to the wallet: messages to the extension background, which holds every
// secret and makes every decision. The app renders what it is given and reports the user's choice.

export interface ConnectPrompt {
  origin: string;
  slots: number[];
  methods: string[];
}

type Response<T> = { ok: true; result: T } | { ok: false; error: { code: number; message: string } };

async function send<T>(message: unknown): Promise<T> {
  const response = (await chrome.runtime.sendMessage(message)) as Response<T>;
  if (!response.ok) throw new Error(response.error.message);
  return response.result;
}

export const getApproval = (id: string) => send<ConnectPrompt | null>({ kind: "approval.get", id });

export const resolveApproval = (id: string, approved: boolean) =>
  send<null>({ kind: "approval.resolve", id, approved });

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
