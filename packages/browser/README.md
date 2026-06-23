# @le-space/browser

This package is the browser/PWA-facing shared layer for reusable Aleph
deployment primitives.

It is intended to sit between:

- `@le-space/core`
- `@le-space/rootfs`
- browser applications such as deployment PWAs

The package should stay UI-neutral. It provides browser-safe helpers, but it
does not own app-specific Svelte state, prepaid enforcement policy, or wallet
UX.

## Client Surface

The preferred public entrypoint is a typed browser client factory:

- `createAlephBrowserClient({ apiHost?, apiHosts?, crnListUrl? })`

That client should remain small and stable. It currently owns:

- balance lookup
- CRN listing
- instance listing
- 2n6 web access lookup
- message envelope lookup
- scheduler allocation lookup
- CRN execution list lookup and normalization
- CRN allocation notify
- relay setup-server configure request
- deployment result inspection and polling
- Aleph message broadcast helpers

Lower-level helper functions remain exported too, but new extractions should
prefer hanging reusable behavior off the client surface unless there is a good
reason to keep them as standalone utilities.

The package also exports lower-level browser/EVM helpers for:

- `ethCall`
- `sendTransaction`
- `personalSign`
- prepaid vault reads and transaction helpers

## Planned v1 Scope

The package currently covers:

- `http.ts`
  - `fetchWithTimeout`
- `aleph-api.ts`
  - balance fetch
  - CRN fetch
  - instance listing
  - Aleph message broadcast helpers
  - deployment polling and result inspection
  - scheduler and CRN runtime lookup helpers
- `client.ts`
  - typed browser client factory
- `rootfs.ts`
  - RootFS manifest load
  - RootFS existence check
  - RootFS reference resolution
- `pricing.ts`
  - instance pricing fetch and parse helpers
- `evm.ts`
  - `ethCall`
  - `sendTransaction`
  - `personalSign`
- `prepaid.ts`
  - reusable prepaid vault protocol helpers

## Not In Scope Initially

These should remain local to apps until the browser package has a stable base:

- wallet-provider integrations
- prepaid enforcement policy and wallet UX
- UI-only formatting helpers
- Svelte state orchestration

## Source Of Truth

The detailed extraction roadmap lives in:

- `docs/docusaurus/docs/architecture/browser-extraction-plan.md`
