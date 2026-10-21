// The user's display settings, kept in persistent storage (they survive a lock and a browser
// restart, and hold nothing secret).
import type { KeyValueStore } from "./vault";

/** How every ECX amount is shown: in whole ECX, or in sats. */
export type Unit = "ecx" | "sats";
export const UNITS: readonly Unit[] = ["ecx", "sats"];

const UNIT_KEY = "settings:unit";

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
  };
}

export type Settings = ReturnType<typeof createSettings>;
