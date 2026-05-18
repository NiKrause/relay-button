# @le-space/browser

This package is the planned browser/PWA-facing layer for reusable Aleph
deployment primitives.

It is intended to sit between:

- `@le-space/core`
- `@le-space/rootfs`
- browser applications such as deployment PWAs

The package should stay UI-neutral. It should provide browser-safe helpers, but
it should not own app-specific Svelte state, prepaid product logic, or wallet
UX.

## Planned v1 Scope

The first real extraction wave should cover:

- `http.ts`
  - `fetchWithTimeout`
- `aleph-api.ts`
  - balance fetch
  - CRN fetch
  - instance listing
  - Aleph message broadcast helpers
  - deployment polling and result inspection
  - runtime detail inspection
- `rootfs.ts`
  - RootFS manifest load
  - RootFS existence check
  - RootFS reference resolution
- `pricing.ts`
  - instance pricing fetch and parse helpers

## Not In Scope Initially

These should remain local to apps until the browser package has a stable base:

- wallet-provider integrations
- prepaid vault flows
- UI-only formatting helpers
- Svelte state orchestration

## Source Of Truth

The detailed extraction roadmap lives in:

- `docs/docusaurus/docs/architecture/browser-extraction-plan.md`
