// Typed access to vault.wasm (core/vault-wasm). Only the Vault orchestration (vault.ts) uses it.
import { CoreModule } from "./wasm";

/** Argon2id costs: memory in KiB, iterations, lanes. */
export interface KdfParams {
  mKib: number;
  t: number;
  p: number;
}

export interface VaultModule {
  /** A new 12-word Master Mnemonic from 16 bytes of the caller's entropy. */
  masterMnemonicFromEntropy(entropy: Uint8Array): string;
  /** A typed phrase in canonical form; throws if it isn't a valid BIP39 phrase. */
  canonicalMnemonic(phrase: string): string;
  /** The Starter for `slot` (BitWindow's DeriveStarter). */
  starter(masterMnemonic: string, passphrase: string, slot: number): string;
  /** The 32-byte vault key: Argon2id of the password. */
  stretchPassword(password: Uint8Array, salt: Uint8Array, params: KdfParams): Uint8Array;
}

export async function loadVaultModule(bytes: BufferSource): Promise<VaultModule> {
  const m = await CoreModule.instantiate(bytes);
  return {
    masterMnemonicFromEntropy: (entropy) => m.callText("master_mnemonic_from_entropy", entropy),
    canonicalMnemonic: (phrase) => m.callText("canonical_mnemonic", phrase),
    starter: (master, passphrase, slot) => m.callText("starter", master, passphrase, slot),
    stretchPassword: (password, salt, { mKib, t, p }) => m.call("stretch_password", password, salt, mKib, t, p),
  };
}
