// The user's display settings and the sidechains they have on, kept in persistent storage (they survive a lock and a browser
// restart, and hold nothing secret).
import type { KeyValueStore } from "./vault";

/** How every ECX amount is shown: in whole ECX, or in sats. */
export type Unit = "ecx" | "sats";
export const UNITS: readonly Unit[] = ["ecx", "sats"];

const UNIT_KEY = "settings:unit";
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

export type Settings = ReturnType<typeof createSettings>;
