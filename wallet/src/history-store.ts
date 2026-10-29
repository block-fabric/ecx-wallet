// Each chain's last history, kept across sessions so Activity shows at once after unlock and the
// next read fetches only what changed (esplora.ts, `EsploraHistorySync`). It names the wallet's
// addresses and every transaction, so it's kept only encrypted: AES-256-GCM in `storage.local`,
// under a key the vault derives from its own while unlocked (`vault.historyKey`). Locked, nothing
// reads or writes it; a new wallet or password has another key, and its first read replaces what
// it can't decrypt. Nothing a transaction is built from comes from it.
import type { KeyValueStore } from "./vault";

export const HISTORY_PREFIX = "history:";

/** Where a chain's history, as one server reported it, is kept. */
export const historyName = (chain: string, url: string) => `${HISTORY_PREFIX}${chain}:${url}`;

/** Each chain's kept history: undefined when locked, never written, or written under another key. */
export interface HistoryStore {
  get<T>(name: string): Promise<T | undefined>;
  set(name: string, value: unknown): Promise<void>;
}

/** What `storage.local` holds per chain: nothing here is readable without the vault's key. */
interface Sealed {
  v: 1;
  iv: string;
  data: string;
}

/** The most a chain's kept history may take (bytes of JSON): a larger one isn't kept, and is read whole each time. */
export const MAX_KEPT_HISTORY_BYTES = 4_000_000;

export function createHistoryStore({ store, key }: { store: KeyValueStore; key: () => Promise<CryptoKey | undefined> }): HistoryStore {
  // The name is the AAD: a sealed history can't be read as another chain's.
  const aad = (name: string) => new TextEncoder().encode(`ecx-wallet ${name}`);
  return {
    async get<T>(name: string): Promise<T | undefined> {
      const [k, sealed] = await Promise.all([key(), store.get<Sealed>(name)]);
      if (k === undefined || sealed?.v !== 1) return undefined;
      try {
        const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(sealed.iv), additionalData: aad(name) }, k, fromBase64(sealed.data));
        return JSON.parse(new TextDecoder().decode(plain)) as T;
      } catch {
        // Another key's (another wallet's, or before a password change): as if never written.
        return undefined;
      }
    },
    async set(name: string, value: unknown): Promise<void> {
      const k = await key();
      if (k === undefined) return;
      const json = new TextEncoder().encode(JSON.stringify(value));
      if (json.length > MAX_KEPT_HISTORY_BYTES) return void (await store.remove(name));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(name) }, k, json));
      await store.set(name, { v: 1, iv: toBase64(iv), data: toBase64(data) } satisfies Sealed);
    },
  };
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}
