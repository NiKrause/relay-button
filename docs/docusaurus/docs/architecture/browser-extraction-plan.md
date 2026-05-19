# Browser Extraction Plan

This plan turns `@le-space/browser` from a placeholder package into a real
browser/PWA-facing shared layer.

The goals are:

- keep reusable Aleph browser logic out of individual PWAs
- let the current `relay-deployer-pwa` adopt shared code incrementally
- make a second, simpler PWA possible without copying the current app's full
  complexity

## Current State

The current PWA already reuses shared logic for:

- RootFS manifest validation and browser-side RootFS resolution
- FORGET message construction helpers
- selected deployment helpers and deployment intent helpers
- Aleph API polling, deployment-result inspection, and scheduler lookup
- browser EVM helpers:
  - `ethCall`
  - `sendTransaction`
  - `personalSign`
- prepaid vault protocol helpers:
  - chain-id mapping
  - budget formatting
  - vault balance/reservation reads
  - vault transaction helpers
- contract-driven `uc-go-peer` rootfs paths and guest-script behavior

The remaining browser-side code still lives partly in
`relay-deployer-pwa/src/lib/`, but the package boundary is much clearer now.

## Extraction Principles

- Keep the shared browser layer UI-neutral.
- Keep wallet-provider integrations local until the shared browser API is
  stable.
- Prefer small vertical slices over large “move everything” refactors.
- Reuse `@le-space/core`, `@le-space/rootfs`, and `@le-space/shared-types`
  rather than duplicating logic in the browser package.

## What Belongs In `@le-space/browser`

The first real browser package should focus on reusable deployment primitives:

- browser-safe HTTP helpers
- Aleph API polling and result normalization
- RootFS manifest loading and RootFS reference resolution
- pricing fetch/parse helpers
- neutral browser-side deployment state models

The package should *not* own:

- Svelte/UI state
- MetaMask or wallet-provider UX flows
- prepaid enforcement policy and app-specific warnings
- app-specific wording and presentation

## Preferred Public Surface

`@le-space/browser` should no longer grow only as a flat bag of helpers.

The preferred public entrypoint is a typed browser client factory:

- `createAlephBrowserClient({ apiHost?, crnListUrl? })`

That client is the stable shared surface we want future PWAs to code against.
Standalone exports are still useful, especially for tests and small utilities,
but new extractions should prefer one of these shapes:

- add a method to `AlephBrowserClient`
- add a browser-neutral result type used by that method

This keeps the package easier to understand for a second, simpler PWA.

## File-By-File Source Map

The current `relay-deployer-pwa/src/lib/` files map roughly like this.

### Completed first-wave shared browser slices

- `http.ts`
  - moved into `@le-space/browser`
- `alephApi.ts`
  - reusable HTTP, polling, envelope parsing, status normalization, and
    selected runtime inspection helpers extracted
- `rootfsManifest.ts`
  - rootfs lookup and resolution helpers extracted
- `pricing.ts`
  - pricing aggregate fetch/parse helpers extracted
- low-level wallet RPC helpers
  - `ethCall`
  - `sendTransaction`
  - `personalSign`
- prepaid vault protocol helpers
  - balance/reservation reads
  - vault transaction helpers

### Remaining second-wave shared browser candidates

- `portForwarding.ts`
  - already mostly shared through `@le-space/core`; browser-side review only if
    a second deployer UI needs a cleaner direct surface
- selective pieces of `deployment.ts`
  - only UI-neutral validation and quoting helpers, not the full form model
- selected browser-facing types from `types.ts`
  - continue shrinking local aliases where the shared browser API is now stable

### Likely app-local for now

- `wallet.ts`
- `prepaid.ts`
- `config.ts`
- `crnGeo.ts`
- `format.ts`

Those either depend on wallet UX, product-specific configuration, or are not
foundational enough for the first browser package.

## Proposed `@le-space/browser` v1 Layout

Current package structure:

```text
packages/browser/
  src/
    index.ts
    http.ts
    aleph-api.ts
    client.ts
    evm.ts
    prepaid.ts
    rootfs.ts
    pricing.ts
    types.ts
```

### `http.ts`

Own:

- `fetchWithTimeout`

### `aleph-api.ts`

Own:

- `normalizeMessageStatus`
- `fetchBalance`
- `fetchCrns`
- `fetchInstances`
- `fetch2n6WebAccessUrl`
- `fetchMessageEnvelope`
- `fetchSchedulerAllocation`
- `fetchCrnExecutionMap`
- `notifyCrnAllocation`
- `configureOrbitdbRelaySetup`
- `broadcastAlephMessage`
- `broadcastInstanceMessage`
- `inspectDeploymentResult`
- `waitForDeploymentResult`
- `normalizeExecution`

### `client.ts`

Own:

- `createAlephBrowserClient`

### `evm.ts`

Own:

- `ethCall`
- `sendTransaction`
- `personalSign`

### `prepaid.ts`

Own:

- `paymentChainFromChainId`
- `formatBudgetUnits`
- `loadPrepaidReservation`
- `loadPrepaidVaultSnapshot`
- `approvePrepaidBudget`
- `depositPrepaidBudget`
- `reserveDeploymentBudget`
- `consumeDeploymentReservation`
- `refundExpiredReservation`

### `rootfs.ts`

Own:

- `loadRootfsManifest`
- `verifyRootfsExists`
- `resolveRootfsReference`

### `pricing.ts`

Own:

- `parseInstancePricing`
- `fetchInstancePricing`

### `types.ts`

Own only browser-neutral exported result shapes needed by the modules above.

## Implementation Order

1. Finish validating the current `uc-go-peer` rootfs build path.
2. Add browser package docs and module plan.
3. Extract `http.ts` into `@le-space/browser`.
4. Extract `alephApi.ts` into `@le-space/browser`.
5. Extract `pricing.ts` into `@le-space/browser`.
6. Extract the remaining `rootfsManifest.ts` browser helpers.
7. Extract generic browser EVM helpers.
8. Extract prepaid vault protocol helpers.
9. Reassess what a second simpler PWA still needs.

## Why This Order

`alephApi.ts` plus `http.ts` gave the biggest reusable value first:

- a shared browser-safe Aleph client layer
- shared polling and normalization behavior
- less duplicated network logic in future browser apps

The later EVM and prepaid extractions are intentionally narrower:

- share the protocol client pieces
- keep wallet UX and prepaid enforcement policy local to apps
