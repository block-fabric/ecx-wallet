// Screenshots of every wallet screen, for checking UI changes by eye (not a test).
//
//   pnpm build && pnpm build:e2e && node e2e/screenshots.mjs <out dir> [light|dark]
//
// Drives the e2e build through the same harness as the e2e suite: onboarding, create, import,
// the account screen with balances from the stub Esplora server, Send, Grants, the
// locked screens, and each kind of approval window. Brave only: over BiDi, Firefox can't resize
// or capture extension pages.
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  ROOT,
  launchWallet,
  openTestApp,
  openWalletPage,
  serveEsplora,
  serveTestApp,
  setUpWallet,
} from "./harness.mjs";

const out = path.resolve(process.argv[2] ?? "screenshots");
const colorScheme = process.argv[3] ?? "light";
const PSETS = JSON.parse(await readFile(path.join(ROOT, "e2e", "fixtures", "elements-psets.json"), "utf8"));
const CHAIN = "ecash:betanet-s24";
const SLOT_24_ADDRESS = "elements1qew44aehkjstjm56ng2rjrz57vwxh5g9su6dlpm";
const POLICY_ASSET = "5836dcc06130dcf6a65b6ac493813fd65559955283e44cc3f07966294eccb2c8";
const OTHER_ASSET = "1111111111111111111111111111111111111111111111111111111111111111";
// Popup width; the approval window is 420 wide (extension/src/background.ts).
const POPUP = { width: 360, height: 600 };
const APPROVAL = { width: 420, height: 640 };

const signingRequest = (payload, overrides = {}) => ({
  version: "1.0",
  id: `req-${Math.random().toString(36).slice(2)}`,
  chain: CHAIN,
  method: "signTransaction",
  format: "pset",
  payload,
  expiresAt: Math.floor(Date.now() / 1000) + 600,
  ...overrides,
});
const request = (page, method, params) => page.evaluate((m, p) => window.testApp.request(m, p), method, params);

await mkdir(out, { recursive: true });
const [session, app, stub] = await Promise.all([
  launchWallet("brave"),
  serveTestApp(),
  serveEsplora({
    genesisHash: "a7754ce0debc40baddbd8c47e79d19209685f22c63edaaf8b69cf54116374d7f",
    utxos: {
      [SLOT_24_ADDRESS]: [
        { txid: "aa".repeat(32), vout: 0, value: 150000, asset: POLICY_ASSET, confirmed: true },
        { txid: "bb".repeat(32), vout: 1, value: 7, asset: OTHER_ASSET, confirmed: true },
      ],
    },
  }),
]);

async function shot(page, name, viewport = POPUP) {
  await page.bringToFront();
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: colorScheme }]);
  await page.setViewport(viewport);
  await new Promise((r) => setTimeout(r, 300));
  // Grow the viewport to the content rather than using `fullPage`, which leaves sticky elements
  // (the approval window's Reject/Sign bar) where the original viewport ended.
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewport({ ...viewport, height: Math.max(viewport.height, height) });
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  console.log(`screenshots: ${name}`);
}

async function open(route, selector) {
  const page = await session.openPage(`index.html${route}`);
  await page.setViewport(POPUP);
  await page.waitForSelector(selector, { timeout: 20_000 });
  return page;
}

async function approval(name, { decide = "[data-reject]", before } = {}) {
  const window = await session.waitForApprovalWindow();
  if (before) await before(window);
  await shot(window, name, APPROVAL);
  if (decide) await window.click(decide);
  else await window.close();
}

try {
  let page = await open("#/", "[data-wallet-ready]");
  await shot(page, "01-onboarding");
  await page.close();

  page = await open("#/create", "[data-phrase]");
  await shot(page, "02-create-phrase");
  await page.click("[data-phrase-saved]");
  await page.waitForSelector("[data-confirm-word]");
  await shot(page, "03-create-confirm");
  await page.close();

  page = await open("#/import", "[data-import-phrase]");
  await shot(page, "04-import");
  await page.close();

  await setUpWallet(session);

  page = await open("#/", "[data-balance]");
  await shot(page, "05-home-unlocked");
  await page.close();

  page = await openWalletPage(session, "#/send/24");
  await page.setViewport(POPUP);
  await page.waitForSelector("[data-send-asset] option");
  await shot(page, "06-send");
  await page.close();

  // Grant requests: one plain, one with the Blind Signing opt-in ticked.
  const shop = await openTestApp(session, app, "shop.localhost");
  const connecting = request(shop, "connect", { slots: [24], methods: ["signTransaction"] });
  await approval("07-approve-grant", { decide: "[data-approve]" });
  await connecting;
  const blindApp = await openTestApp(session, app, "blind.localhost");
  const connectingBlind = request(blindApp, "connect", { slots: [24], methods: ["signTransaction"] });
  await approval("08-approve-grant-blind-opt-in", {
    decide: "[data-approve]",
    before: (w) => w.click("[data-blind-opt-in]"),
  });
  await connectingBlind;

  const hints = { summary: "Pay Bob for the bike", outputLabels: { 0: "change", 1: "Bob" } };
  let signing = request(shop, "signTransaction", signingRequest(PSETS.clear.payload, { hints }));
  await approval("09-approve-clear");
  await signing;

  signing = request(shop, "signTransaction", signingRequest(PSETS.dangerous.payload));
  await approval("10-approve-dangerous");
  await signing;

  const blindHints = { summary: "A perfectly normal transfer" };
  signing = request(blindApp, "signTransaction", signingRequest(PSETS.blind.payload, { hints: blindHints }));
  await approval("11-approve-blind");
  await signing;

  page = await openWalletPage(session, "#/grants");
  await page.setViewport(POPUP);
  await shot(page, "12-grants");
  await page.close();

  const home = await open("#/", "[data-lock]");
  await home.click("[data-lock]");
  await home.waitForSelector('[data-vault-state="locked"]');
  await shot(home, "13-home-locked");
  await home.type("[data-password]", "wrong password");
  await home.click("[data-unlock]");
  await home.waitForSelector("[data-error]");
  await shot(home, "14-home-wrong-password");

  // Left pending; it fails once the browser closes.
  request(shop, "signTransaction", signingRequest(PSETS.clear.payload)).catch(() => {});
  await approval("15-approve-unlock-required", { decide: null });
} finally {
  await session.close();
  await app.close();
  await stub.close();
}
