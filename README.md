# shared-aleph-tooling

Shared Aleph VM deployment, rootfs, and automation tooling for the Aleph-based
deployment flows used by:

- `universal-connectivity`
- `relay-deployer-pwa`

The long-term goal is to make this repository the source of truth for shared
Aleph logic, while consumer repos keep only thin wrappers and app-specific
behavior.

## Current Status

This repository is no longer only a folder layout. It already contains working
shared implementation for:

- rootfs manifest validation
- Aleph message broadcasting and inspection
- CRN discovery, ranking, and retry
- runtime polling and diagnostics
- `uc-go-peer` guest configuration and verification
- successful-deployment retention cleanup
- a shared GitHub deploy action
- a working Docusaurus docs app

Still intentionally early:

- `@shared-aleph/browser` is scaffold-only
- `@shared-aleph/rootfs` is scaffold-only
- the shared reusable workflow is still placeholder-level

## Workspace Packages

- `@shared-aleph/shared-types`
  Shared contracts used across packages.
- `@shared-aleph/core`
  Reusable Aleph deployment, runtime, CRN, guest, and retention logic.
- `@shared-aleph/node`
  Node adapters for signing, env parsing, GitHub outputs, and action runner
  orchestration.
- `@shared-aleph/browser`
  Reserved for future browser and wallet-driven flows.
- `@shared-aleph/rootfs`
  Reserved for reusable rootfs build and guest-script packaging.

## Automation Entry Points

- GitHub Action: [`.github/actions/aleph-vm-deploy/action.yml`](./.github/actions/aleph-vm-deploy/action.yml)
- Reusable workflow: [`.github/workflows/aleph-rootfs-build-publish-deploy.yml`](./.github/workflows/aleph-rootfs-build-publish-deploy.yml)

## Docs

The docs app lives in [`docs/docusaurus`](./docs/docusaurus). The current docs
cover:

- overview
- package boundaries
- deployment lifecycle
- GitHub Action reference
- rootfs contract direction
- reusable workflow status

## Quick Start

```bash
pnpm install
pnpm test
pnpm docs:build
```

Useful commands:

- `pnpm docs:dev`
- `pnpm docs:build`
- `pnpm --filter @shared-aleph/core test`
- `pnpm --filter @shared-aleph/node test`

## Repository Shape

```text
shared-aleph-tooling/
  packages/
  .github/actions/
  .github/workflows/
  docs/docusaurus/
  examples/
```

## Near-Term Roadmap

1. Extract reusable rootfs logic into `@shared-aleph/rootfs`.
2. Replace the placeholder reusable workflow with the real shared pipeline.
3. Split this directory into its own standalone git repository.
4. Make `universal-connectivity` consume the shared repo through a real external
   reference instead of a local relative path.

## npm Publishing Direction

Publishing from the standalone repo is the right long-term model, but this
monorepo is not fully npm-ready yet.

Current blockers:

- the package set that should become public is not finalized yet
- several packages still intentionally remain scaffold-only
- package entrypoints still point at source files instead of a dedicated publish
  build output
- release automation and npm credentials are not configured yet
- the final license and public repository URL still need to be decided

The tracked publishing checklist lives in [`PUBLISHING.md`](./PUBLISHING.md).
