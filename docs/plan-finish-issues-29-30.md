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

## Open investigation: relay VM dead on arrival (run simple-todo #37, 2026-07-19)

Facts: image orbitdb-relay-v0.9.7 (f50d5005…, built Jul 13) is the same one that was green on Jul 14; the 0.6.30 rootfs source changes were never built into an image (Build Publish Deploy workflow: 0 runs). In run #37 the VM was submitted to CRN NodeCity3, but showed zero guest signals: the bootstrap registration was published by the BROWSER fallback (publisher = E2E wallet, registrationId embeds a non-instance hash cd41d9cc…), and all three relay endpoints refused connections for the full 8-minute dial window. Deploy-side delta since the last green run: @le-space/ui 0.6.23 → 0.6.30 (guest configured via HTTP POST to VM:80/configure with runtime IPv4 from the CRN).

RESOLVED (run #38 live probes, 2026-07-19): hypothesis (a) confirmed and root-caused.
- Scheduler: "VM is not allocated to any node"; CRN executions list did not contain the instance.
- Manual POST to NodeCity3 /control/allocation/notify for the live instance returned **503 "This CRN cannot host the requested instance at this time"** - the CRN is at capacity (13 running executions, none owned by the E2E wallet, some since April).
- The UI treats the failed notify as non-fatal: no "Deployment failed" surfaces, the browser-fallback registration is published anyway, and consumers burn the dial window against a VM that never existed.
- Jul 14 was green simply because NodeCity3 still had capacity.

Fixes: (1) ui/browser: treat allocation-notify 503 as a hard deployment failure surfaced in the panel (the E2E already detects panel errors and would fail in seconds); (2) CRN selection should skip full CRNs / retry the next deployable CRN from the list instead of pinning the first candidate; (3) simple-todo guard branch fix/e2e-guest-registration-guard (fail fast on fallback-only registration) as defense in depth.

Hardening ideas from this run: the E2E should fail fast (or at least warn) when the found registration's publisher is the test wallet (fallback ≠ guest alive); check scheduler allocation before dialing; the browser fallback masks guest death in tests.

## RESOLVED — remote-replication `candidates: 0` = profile-blind relay discovery (2026-07-20)

Root cause of simple-todo remote-replication failing at `connecting-browser-peers` (runs on main since ~2026-07-19 18:00, e.g. run 29701742830): **two relay implementations register `relay-bootstrap-v2` posts in the same Aleph channel `simple-todo`**, and `discoverAlephBootstrapMultiaddrs` filtered by channel/type/trust/age but **never by `profile`**.

- `profile: "orbitdb-relay"` → simple-todo's relay (`orbitdb-relay/aleph/contract.json`).
- `profile: "uc-go-peer"` → universal-connectivity's go-peer relay (`go-peer/aleph/uc-go-peer.json`).
- **Rule going forward: simple-todo works ONLY through `orbitdb-relay`; universal-connectivity works ONLY through `uc-go-peer`.** Both registered in one channel → discovery mixes them → an orbitdb browser connects to a `uc-go-peer` relay, no shared circuit, `candidates: 0`.

Evidence (2026-07-20): live channel `simple-todo` held **2 `orbitdb-relay` vs 29 `uc-go-peer`** posts. The failing run's build (`resolve-aleph-bootstrap.mjs`) baked in a mix — `ignore-jaguar-scene-pole.2n6.me` (orbitdb ✓) + `37-114-50-44…libp2p.direct` (uc-go-peer ✗); both passed the ping probe. The lone live `orbitdb-relay` was probed directly and **grants a working browser circuit-relay reservation** (two libp2p nodes connected through it, ping 115 ms) — so the relay is fine; only discovery scoping was wrong.

Correction to earlier notes: this is **not** a 0.6.32→0.6.33 regression. That bump's only functional change was `SponsorRelayController` guest-setup retry 15→45 (`ac65fc0`); core/browser/aleph-bootstrap source is byte-identical between 0.6.32 and 0.6.33. The clean green→red version boundary was coincidental with relay-mix flakiness. The stale `pill-execute` PROD pin in `.env.example` is also a non-issue for CI (the build overwrites `VITE_RELAY_BOOTSTRAP_ADDR_PROD` from the live snapshot).

Fix (in flight):
- **relay-button PR #49** (`fix/relay-bootstrap-profile-scope`, bumps to **0.6.34**): optional `profile?: string | string[]` on `DiscoverAlephBootstrapOptions`, applied via new `filterRelayBootstrapPostsByProfile`. Backward compatible; live-validated. Unit tests 18/18.
- **Release 0.6.34**: merge PR #49 → run `Release Packages` (`workflow_dispatch`, `dry_run=false`, `npm_tag=latest`, `npm_scope=le-space`). npm is never auto-published.
- **simple-todo** (wired, pending 0.6.34 publish + dep bump): `resolve-aleph-bootstrap.mjs` and `ManualConnectForm.svelte` now pass `profile: 'orbitdb-relay'` (env-overridable via `RELAY_BOOTSTRAP_PROFILE` / `VITE_RELAY_BOOTSTRAP_PROFILE`). Bump `@le-space/aleph-bootstrap` + `@le-space/ui` 0.6.33 → 0.6.34, then push to re-run remote-replication.
- **Phase 4 — universal-connectivity mirror (TODO):** scope its build/runtime relay discovery to `profile: 'uc-go-peer'` (mirror of simple-todo). Same shared-channel confusion applies in reverse. Also consider: give each project its own Aleph channel instead of the shared `DEFAULT_ALEPH_BOOTSTRAP_CHANNEL = "simple-todo"` default, as belt-and-suspenders.
- **Second, separate bug (relay-button E2E, run 29701742716):** the freshly-provisioned relay's browser WSS fails the TLS handshake (`net::ERR_SSL_PROTOCOL_ERROR` on the AutoTLS `libp2p.direct` address) — flaky across 0.6.32/0.6.33, an AutoTLS/cert-timing issue on the relay image, to be tackled after this one.

## Standing risks

- **Release ordering**: testkit/ui/core publish together (0.6.31); consumers pin exact versions in lockfiles — bump deliberately, not `@main`/`latest`.
- **Concurrency group** `relay-button-e2e` cancels queued runs (run #34) — push batches, then verify the final run, not intermediate ones.
- **Bootstrap freshness** is now 24 h (b6eddf3) — stale-registration tests or janitor assumptions relying on 7 days need review.
- **35-min wall**: any E2E with 30-min test timeout needs job timeout ≥ ~40 min to preserve evidence on failure.
