# Plan: finish relay-button #29 (testkit) & #30 (Aleph Playwright runner)

Scope: relay-button, simple-todo, later universal-connectivity.
State as of 2026-07-19: main of simple-todo is restored Phase A (92ce315) + local spec fix; relay-button main is fc8832c (0.6.31 bump, unreleased) + local type fix.

## Phase 0 — Unblock (relay-button + simple-todo, ~1 day)

1. **relay-button: release 0.6.31**
   - Commit the local fix `packages/playwright/src/index.ts` → `launcherName?: string | RegExp` (fixes `Type 'string | RegExp' is not assignable to type 'RegExp'` that killed CI #442 / Release Packages #137).
   - Verified locally: `tsc --noEmit -p tsconfig.publish.json` clean, 14/14 package tests pass.
   - PR → merge → CI green → run Release Packages → 0.6.31 on npm.
2. **simple-todo: make Relay button E2E green on main (pre-testkit baseline)**
   - Commit the local fix in `e2e/relay-button-provisioning.spec.js`: match registration by `instanceName` OR `instanceHash` (port of collab01 d7f6f37). Root cause of runs #28/#29/#35 failing with 31-min registration timeout since relay-button 0.6.30 changed guest registration to `relay:<profile>:<name>`.
   - Workflow hygiene in `relay-button-e2e.yml`: raise `timeout-minutes: 35 → 40` (test timeout is 30 min; timed-out runs #32/#33 were killed before evidence upload).
   - Push, confirm Relay button E2E green. **Gate: do not proceed until green.**

## Phase 1 — relay-button: close #30 remnants (~1–2 days)

3. **Consolidate cleanup (the "Post-Merge cleanup" item in #30)**
   - New standalone CLI `scripts/playwright-runner-cleanup.mjs` in relay-button, published (or self-contained) — no cross-repo relative imports like `../../../packages/core/src/index.ts` in the composite action.
   - Composite action wraps the CLI; delete `aleph-playwright-runner-cleanup/cleanup-exact.mjs`; consumers drop their copies (simple-todo `scripts/cleanup-aleph-instance.mjs`).
   - Keep the lesson from runs #83/#84: any deps of the CLI must be direct deps where it runs (pnpm strict mode).
4. **Cost breakdown**: workflow summary line with exact Aleph cost from authoritative billing data (deploy + runtime, per run).
5. **Docs**: Docusaurus pages + Mermaid diagrams for runner RootFS, WSS auth flow, TTL/janitor, cleanup contract.
6. **Janitor gaps** (from run 29679993674 analysis — janitor itself is green, but):
   - Scope: `selectExpiredAlephPlaywrightRunners` only matches `playwright-<repo>-*` runner VMs; orphaned **relay** VMs (`simple-todo-e2e-<timestamp>`) from hard-cancelled E2E runs are never cleaned and keep locking ALEPH balance. Extend the janitor (or add a relay janitor) with an opt-in prefix list, e.g. `simple-todo-e2e-`.
   - Pin: simple-todo's `aleph-playwright-janitor.yml` references the reusable workflow `@fix/guest-bootstrap-cleanup` (temporary branch) — repoint to `@main` or a tag before the branch is deleted.
   - Hygiene: bump `pnpm/action-setup@v4` → v6 and `actions/upload-artifact@v4` → v6 (Node 20 deprecation warnings).

## Phase 2 — simple-todo: re-apply Phase B + testkit migration (~2–3 days)

Order matters — this is where yesterday's cascade started. One PR per step, E2E green between steps.

6. **Fix simple-todo #38 first** (lazy relay discovery): ManualConnectForm must not auto-ping up to 50 discovered relays on load (caused `verifying-relays` 120 s waitForFunction timeouts → runs #32/#33 hit job timeout). On-demand discovery + small ping budget. If the fix lands in `@le-space/ui`, release it before migrating.
7. **Re-apply testkit migration (issue #29)** — redo 5e1a33e on top of green main with `@le-space/playwright@0.6.31`:
   - `RelayButtonDriver` default launcher now exact `'Relay Button'` (PR #41) — no strict-mode clash, no local workaround needed.
   - Testkit `waitForBootstrapRegistration` matches `:${instanceName}:` — supersedes the Phase 0 spec fix.
   - Use `relayTest` fixture for describe/skip/timeout (the #31 mistake), keep evidence writer + artifact upload.
   - Delete the then-duplicated local helpers from the spec.
8. **Re-apply Phase B (PR #37 content)** for Remote browser replication: composite deploy/connect/cleanup actions + dedicated `playwright-runner` RootFS. This already worked (run #85 green on the branch; RootFS #9 and Live Validation green). Include: `@le-space/core` + `@le-space/node` as direct deps (or obsolete via step 3 CLI), pinned action ref (tag, not `@main`).
9. **Phase C for simple-todo**: `aleph` as default provider in the remote-replication workflow; keep janitor cron; close simple-todo #39 (fix-forward, revert no longer needed) and #38.

## Phase 3 — universal-connectivity (~1–2 days)

10. **Driver contract parity** (#29 open checkbox "same page-driver contract for React and Svelte"): both UIs render `Relay Button`; run universal-connectivity's testkit E2E against 0.6.31 to confirm no regression from the string default; align any remaining role/label differences in the testkit, not per-app.
11. **Phase C integration**: switch its remote-replication workflow from Phase A SSH bootstrap to the Phase B composite actions + runner RootFS (mirror of step 8), evidence + cleanup verification identical.
12. **Close out**: Docusaurus docs for testkit usage in both consumers → tick remaining #29 checkboxes → close #29; note #30 remnants done in the issue.

## Standing risks

- **Release ordering**: testkit/ui/core publish together (0.6.31); consumers pin exact versions in lockfiles — bump deliberately, not `@main`/`latest`.
- **Concurrency group** `relay-button-e2e` cancels queued runs (run #34) — push batches, then verify the final run, not intermediate ones.
- **Bootstrap freshness** is now 24 h (b6eddf3) — stale-registration tests or janitor assumptions relying on 7 days need review.
- **35-min wall**: any E2E with 30-min test timeout needs job timeout ≥ ~40 min to preserve evidence on failure.
