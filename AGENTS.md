# ECX Wallet

A multi-drivechain browser wallet for eCash (ECX). Design work is tracked as a wayfinder map: [ECX Wallet: Wallet Base spec](https://github.com/marcusmmmz/ecx-wallet/issues/1).

## Agent skills

### Issue tracker

Issues, specs and the wayfinder map live in GitHub Issues for marcusmmmz/ecx-wallet (via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Build and test

One command: `pnpm test` (builds, then runs the e2e suite in headless Brave and Firefox). Layout and harness: `README.md`.
