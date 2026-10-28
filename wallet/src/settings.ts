// The user's display settings and the sidechains they have on, kept in persistent storage (they survive a lock and a browser
// restart, and hold nothing secret).
import type { KeyValueStore } from "./vault";

/** How every ECX amount is shown: in whole ECX, or in sats. */
export type Unit = "ecx" | "sats";
export const UNITS: readonly Unit[] = ["ecx", "sats"];

const UNIT_KEY = "settings:unit";
const REREAD_KEY = "settings:rereadSeconds";

/** How often a shown wallet reads its chains again, in seconds: a minute unless the user picks otherwise, within these. */
export const REREAD_SECONDS = { min: 15, max: 300, default: 60 } as const;
/** Per chain id (CAIP-2): a chain is on only once the user (or an app, with their approval) turned it on. */
const chainOnKey = (chain: string) => `settings:chainOn:${chain}`;

export function createSettings(store: KeyValueStore) {
  return {
    /** ECX unless the user picked sats. */
    async unit(): Promise<Unit> {
      const stored = await store.get<string>(UNIT_KEY);
      return stored === "sats" ? "sats" : "ecx";
    },
    async setUnit(unit: string): Promise<void> {
      if (!UNITS.includes(unit as Unit)) throw new Error(`Unknown unit: ${unit}.`);
      await store.set(UNIT_KEY, unit);
    },
    /** How often a shown wallet reads its chains again, in seconds. */
    async rereadSeconds(): Promise<number> {
      const stored = await store.get<number>(REREAD_KEY);
      return typeof stored === "number" && Number.isFinite(stored) ? clampReread(stored) : REREAD_SECONDS.default;
    },
    async setRereadSeconds(seconds: number): Promise<void> {
      if (!Number.isFinite(seconds)) throw new Error("Reading again needs a number of seconds.");
      await store.set(REREAD_KEY, clampReread(seconds));
    },
    /**
     * Whether the user has the sidechain `chain` on: shown, counted and read from its server. Off
     * until turned on. The main chain is always on; its callers don't ask.
     */
    async chainOn(chain: string): Promise<boolean> {
      return (await store.get<boolean>(chainOnKey(chain))) === true;
    },
    async setChainOn(chain: string, on: boolean): Promise<void> {
      await store.set(chainOnKey(chain), on);
    },
  };
}

const clampReread = (seconds: number) => Math.min(REREAD_SECONDS.max, Math.max(REREAD_SECONDS.min, Math.round(seconds)));

export type Settings = ReturnType<typeof createSettings>;
