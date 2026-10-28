// How closely someone is looking at this page: "attended" while it has focus or the pointer is
// over it, "shown" while it's on screen without either (a side panel off to one side), "hidden"
// while it isn't on screen (another tab, a minimized window).

export type Attention = "attended" | "shown" | "hidden";

/** Watches this page's attention until `stop`; `onReturn` runs each time it becomes attended again. */
export function attention(): { state(): Attention; onReturn(run: () => void): () => void; stop(): void } {
  let hovered = false;
  let focused = typeof document !== "undefined" && document.hasFocus();
  const returns = new Set<() => void>();
  const state = (): Attention => (document.visibilityState !== "visible" ? "hidden" : focused || hovered ? "attended" : "shown");

  // Each change to "attended" from anything else is a return.
  let last = state();
  const changed = () => {
    const now = state();
    if (now === "attended" && last !== "attended") for (const run of returns) run();
    last = now;
  };
  const listeners: [EventTarget, string, () => void][] = [
    [document.documentElement, "pointerenter", () => ((hovered = true), changed())],
    [document.documentElement, "pointerleave", () => ((hovered = false), changed())],
    [window, "focus", () => ((focused = true), changed())],
    [window, "blur", () => ((focused = false), changed())],
    [document, "visibilitychange", changed],
  ];
  for (const [target, type, listener] of listeners) target.addEventListener(type, listener);

  return {
    state,
    onReturn(run) {
      returns.add(run);
      return () => returns.delete(run);
    },
    stop() {
      for (const [target, type, listener] of listeners) target.removeEventListener(type, listener);
    },
  };
}
