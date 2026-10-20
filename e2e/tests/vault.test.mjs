// Seam 1: create, import, lock and unlock the wallet, driven through the wallet's own pages in a
// real browser. Each test gets a fresh browser profile (a profile holds at most one wallet).
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { BROWSERS, launchBrave, launchWallet } from "../harness.mjs";

const PHRASE = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const PASSPHRASE = "ecx-e2e-passphrase-Q7";
const PASSWORD = "correct horse battery";

/** Opens a wallet page (`route` is the hash route, e.g. "create") once it has rendered. */
async function openWallet(session, route = "") {
  const page = await session.openPage(`index.html#/${route}`);
  await page.waitForSelector("[data-wallet-ready]", { timeout: 10_000 });
  return page;
}

/** Which state the home page shows: "onboarding", "locked" or "unlocked". */
async function homeState(session) {
  const page = await openWallet(session);
  const state = await page.$eval("[data-vault-state]", (e) => e.dataset.vaultState);
  await page.close();
  return state;
}

async function typeInto(page, selector, text) {
  await page.$eval(selector, (e) => (e.value = ""));
  await page.type(selector, text);
}

async function importWallet(session, { phrase = PHRASE, passphrase = PASSPHRASE, password = PASSWORD } = {}) {
  const page = await openWallet(session, "import");
  await typeInto(page, "[data-import-phrase]", phrase);
  if (passphrase) await typeInto(page, "[data-import-passphrase]", passphrase);
  await typeInto(page, "[data-new-password]", password);
  await typeInto(page, "[data-repeat-password]", password);
  await page.click("[data-submit]");
  return page;
}

/** Imports PHRASE (with PASSPHRASE) and waits until the wallet shows as unlocked. */
async function setUpWallet(session) {
  const page = await importWallet(session);
  await page.waitForSelector('[data-vault-state="unlocked"]');
  await page.close();
}

async function unlock(page, password) {
  await typeInto(page, "[data-password]", password);
  await page.click("[data-unlock]");
}

/** Text a user could read on the page, plus every form field's value. */
const visibleText = (page) =>
  page.evaluate(() => [document.body.innerText, ...[...document.querySelectorAll("input, textarea")].map((e) => e.value)].join("\n"));

for (const browserName of BROWSERS) describe(browserName, () => {
  async function withWallet(fn) {
    const session = await launchWallet(browserName);
    try {
      await fn(session);
    } finally {
      await session.close();
    }
  }

  test("a new browser profile starts at onboarding", () =>
    withWallet(async (session) => {
      assert.equal(await homeState(session), "onboarding");
    }));

  test("create: the phrase is shown once, some of its words must be confirmed, then the wallet is unlocked", () =>
    withWallet(async (session) => {
      const page = await openWallet(session, "create");
      const words = await page.$$eval("[data-phrase] [data-word]", (es) => es.map((e) => e.textContent.trim()));
      assert.equal(words.length, 12);
      assert.ok(words.every((w) => /^[a-z]+$/.test(w)), `words: ${words}`);
      await page.click("[data-phrase-saved]");

      // The phrase is gone from the screen; the user is asked for some of its words by position.
      await page.waitForSelector("[data-confirm-word]");
      assert.equal(await page.$("[data-phrase]"), null);
      const positions = await page.$$eval("[data-confirm-word]", (es) => es.map((e) => Number(e.dataset.confirmWord)));
      assert.ok(positions.length >= 2 && positions.length < 12, `asks for ${positions.length} words`);

      // A wrong word is refused.
      const [first, ...rest] = positions;
      await typeInto(page, `[data-confirm-word="${first}"]`, words[first - 1] === "zoo" ? "abandon" : "zoo");
      for (const n of rest) await typeInto(page, `[data-confirm-word="${n}"]`, words[n - 1]);
      await typeInto(page, "[data-new-password]", PASSWORD);
      await typeInto(page, "[data-repeat-password]", PASSWORD);
      await page.click("[data-submit]");
      await page.waitForSelector("[data-error]");
      assert.match(await page.$eval("[data-error]", (e) => e.textContent), /word/i);

      // The right words create the wallet and leave it unlocked.
      await typeInto(page, `[data-confirm-word="${first}"]`, words[first - 1]);
      await page.click("[data-submit]");
      await page.waitForSelector('[data-vault-state="unlocked"]');
      assert.equal(await homeState(session), "unlocked");

      // Shown once: nothing in the wallet shows the phrase again, and create isn't offered twice.
      for (const route of ["", "create"]) {
        const again = await openWallet(session, route);
        const text = await visibleText(again);
        assert.ok(!words.some((w, i) => i > 0 && text.includes(`${words[i - 1]} ${w}`)), `#/${route} shows the phrase`);
        await again.close();
      }
      await page.close();
    }));

  test("import: an invalid phrase is refused; a valid one with a passphrase opens the wallet unlocked", () =>
    withWallet(async (session) => {
      const bad = await importWallet(session, { phrase: "legal winner thank year wave sausage worth useful legal winner thank thank" });
      await bad.waitForSelector("[data-error]");
      assert.match(await bad.$eval("[data-error]", (e) => e.textContent), /phrase/i);
      await bad.close();
      assert.equal(await homeState(session), "onboarding");

      const page = await importWallet(session);
      await page.waitForSelector('[data-vault-state="unlocked"]');
      await page.close();
      assert.equal(await homeState(session), "unlocked");
    }));

  test("lock and unlock: the right password unlocks; a wrong one says only 'Incorrect password.'", () =>
    withWallet(async (session) => {
      await setUpWallet(session);
      const page = await openWallet(session);
      await page.waitForSelector('[data-vault-state="unlocked"]');
      await page.click("[data-lock]");
      await page.waitForSelector('[data-vault-state="locked"]');
      assert.equal(await homeState(session), "locked");

      await unlock(page, "wrong password");
      await page.waitForSelector("[data-error]");
      assert.equal(await page.$eval("[data-error]", (e) => e.textContent.trim()), "Incorrect password.");
      assert.equal(await homeState(session), "locked");

      await unlock(page, PASSWORD);
      await page.waitForSelector('[data-vault-state="unlocked"]');
      assert.equal(await homeState(session), "unlocked");
      await page.close();
    }));

  test("the wallet locks itself after the auto-lock delay without activity", () =>
    withWallet(async (session) => {
      await setUpWallet(session);
      const page = await openWallet(session);
      // Auto-lock after 1.5 s instead of the default 15 minutes.
      await page.evaluate(() => chrome.runtime.sendMessage({ kind: "vault.setAutoLock", minutes: 0.025 }));
      await page.click("[data-lock]");
      await page.waitForSelector('[data-vault-state="locked"]');
      await unlock(page, PASSWORD);
      await page.waitForSelector('[data-vault-state="unlocked"]');
      assert.equal(await homeState(session), "unlocked");
      await new Promise((r) => setTimeout(r, 2_500));
      assert.equal(await homeState(session), "locked");
      await page.close();
    }));

  test("nothing unencrypted that derives from the Master Mnemonic is in persistent storage", () =>
    withWallet(async (session) => {
      await setUpWallet(session);
      assert.equal(await homeState(session), "unlocked");
      const page = await openWallet(session);
      const stored = JSON.stringify(await page.evaluate(() => chrome.storage.local.get(null)));
      await page.close();
      assert.ok(stored.length > 0);
      for (const secret of ["legal winner", "winner thank", PASSPHRASE, PASSWORD]) {
        assert.ok(!stored.includes(secret), `storage.local contains ${secret}`);
      }
    }));
});

// Brave only: stopping the service worker and restarting the browser on one profile need CDP and
// a persistent profile (Firefox's temporary add-ons don't survive a restart).
describe("brave: restarts", { skip: !BROWSERS.includes("brave") }, () => {
  test("the wallet stays unlocked across a forced service-worker restart", async () => {
    const session = await launchBrave();
    try {
      await setUpWallet(session);
      assert.equal(await homeState(session), "unlocked");
      assert.ok((await session.stopServiceWorker()) > 0, "a running worker was stopped");
      assert.equal(await homeState(session), "unlocked");
      // And the restarted worker can still lock it.
      const page = await openWallet(session);
      await page.click("[data-lock]");
      await page.waitForSelector('[data-vault-state="locked"]');
      await page.close();
    } finally {
      await session.close();
    }
  });

  test("a browser restart leaves the wallet locked, and the profile on disk holds no plaintext secret", async () => {
    const profile = await mkdtemp(path.join(tmpdir(), "ecx-e2e-brave-restart-"));
    try {
      const first = await launchBrave({ profile });
      try {
        await setUpWallet(first);
        assert.equal(await homeState(first), "unlocked");
      } finally {
        await first.close();
      }

      for (const file of await filesUnder(profile)) {
        const bytes = await readFile(file).catch(() => Buffer.alloc(0));
        for (const secret of ["legal winner thank", PASSPHRASE, PASSWORD]) {
          assert.ok(!bytes.includes(secret), `${path.relative(profile, file)} contains ${secret}`);
        }
      }

      const second = await launchBrave({ profile });
      try {
        assert.equal(await homeState(second), "locked");
        const page = await openWallet(second);
        await unlock(page, PASSWORD);
        await page.waitForSelector('[data-vault-state="unlocked"]');
        await page.close();
      } finally {
        await second.close();
      }
    } finally {
      await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

async function filesUnder(dir) {
  return (await readdir(dir, { recursive: true, withFileTypes: true }))
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath, e.name));
}
