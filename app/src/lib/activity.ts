// The auto-lock counts using a wallet page as activity: a pointer or key event on any wallet page
// (home, Send, Deposit, the approval window) tells the background, at most once a minute. A page
// that's open but untouched doesn't keep the wallet unlocked.
import { activityReporter } from "$lib/background";

const AT_MOST_EVERY_MS = 60_000;

/** Starts reporting this page's use; returns the stop. */
export function reportActivity(): () => void {
  const reporter = activityReporter();
  let last = -Infinity;
  const used = () => {
    const now = Date.now();
    if (now - last < AT_MOST_EVERY_MS) return;
    last = now;
    reporter.used();
  };
  window.addEventListener("pointerdown", used, { capture: true });
  window.addEventListener("keydown", used, { capture: true });
  return () => {
    window.removeEventListener("pointerdown", used, { capture: true });
    window.removeEventListener("keydown", used, { capture: true });
    reporter.stop();
  };
}
