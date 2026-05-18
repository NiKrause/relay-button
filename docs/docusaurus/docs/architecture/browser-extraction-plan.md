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

- RootFS manifest validation
- FORGET message construction helpers
- selected deployment helpers
- contract-driven `uc-go-peer` rootfs paths and guest-script behavior

The remaining browser-side code still lives mostly in
`relay-deployer-pwa/src/lib/`.

Some of those files already contain unrelated local work in progress, so the
browser extraction path should start with the cleanest reusable modules first.

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
- prepaid vault product logic
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

### First-wave shared browser candidates

- `http.ts`
  - move into `@le-space/browser` as-is
- `alephApi.ts`
  - extract reusable HTTP, polling, envelope parsing, status normalization, and
    runtime inspection helpers
- `rootfsManifest.ts`
  - continue moving rootfs lookup and resolution helpers into shared browser
    code
- `pricing.ts`
  - move Aleph pricing aggregate fetch/parse helpers into shared browser code

### Second-wave shared browser candidates

- `portForwarding.ts`
  - reusable if multiple deployer UIs will manage instance networking
- selective pieces of `deployment.ts`
  - only UI-neutral validation and quoting helpers, not the full form model
- selected browser-facing types from `types.ts`
  - extract only after the shared browser API is clearer

### Likely app-local for now

- `wallet.ts`
- `prepaid.ts`
- `config.ts`
- `crnGeo.ts`
- `format.ts`

Those either depend on wallet UX, product-specific configuration, or are not
foundational enough for the first browser package.

## Proposed `@le-space/browser` v1 Layout

Start with a small package structure:

```text
packages/browser/
  src/
    index.ts
    http.ts
    aleph-api.ts
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
- `fetchMessageEnvelope`
- `createAlephBrowserClient`
- `broadcastAlephMessage`
- `broadcastInstanceMessage`
- `inspectDeploymentResult`
- `waitForDeploymentResult`
- `fetchInstanceRuntimeDetails`

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
7. Adopt those modules back into `relay-deployer-pwa`.
8. Reassess what a second simpler PWA still needs.

## Why This Order

`alephApi.ts` plus `http.ts` gives the biggest reusable value first:

- a shared browser-safe Aleph client layer
- shared polling and normalization behavior
- less duplicated network logic in future browser apps

That is a better first milestone than starting with wallet or prepaid code,
which are more app-specific.
