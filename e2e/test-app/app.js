// A minimal Sidechain App: it finds the wallet only through the `client` library's discovery.
// Tests drive it through `window.testApp`.
import { discoverProviders } from "@ecx/client";

let provider;

window.testApp = {
  /** Discovers wallets; returns what an outsider can see about them. */
  async discover() {
    const found = await discoverProviders();
    provider = found[0]?.provider;
    return found.map(({ info }) => info);
  },

  /** True if any own property of `window` holds the discovered Provider. */
  providerIsOnWindow() {
    return Object.getOwnPropertyNames(window).some((name) => {
      try {
        return window[name] === provider;
      } catch {
        return false;
      }
    });
  },

  /** Calls `provider.request` and returns `{ result }` or `{ error: { code, message } }`. */
  async request(method, params) {
    if (!provider) await this.discover();
    try {
      return { result: await provider.request({ method, params }) };
    } catch (error) {
      return { error: { code: error.code, message: error.message } };
    }
  },
};
