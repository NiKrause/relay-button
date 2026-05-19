# shared-aleph-tooling

Reusable Aleph Cloud deployment tooling for projects that need to:

- build and publish RootFS images
- deploy Aleph VM instances
- publish static sites through Aleph/IPFS
- verify deployed relays and bootstrap addresses
- clean up older Aleph deployment records

This repository is the implementation layer behind the Aleph deployment flows
used by consumer projects such as `universal-connectivity`.

## What It Contains

Packages use the `@le-space/*` scope.

### Packages

- `@le-space/shared-types`
  Shared types and contracts used across the workspace.
- `@le-space/core`
  Aleph-specific deployment, runtime, CRN, guest, and retention logic.
- `@le-space/node`
  Node entrypoints and adapters for:
  - RootFS build/publish
  - site publish and domain link
  - VM deploy and retention actions
  - GitHub Actions output and summary handling
- `@le-space/rootfs`
  RootFS planning, manifests, reference assets, and build helpers.
- `@le-space/browser`
  Browser-safe Aleph deployment helpers for PWAs and other browser clients.
  Current scope includes Aleph API polling, RootFS resolution, pricing,
  browser EVM helpers, and prepaid vault protocol helpers.

### GitHub Automation

- [`.github/actions/aleph-vm-deploy/action.yml`](./.github/actions/aleph-vm-deploy/action.yml)
  GitHub Action wrapper for Aleph VM deployment operations.
- [`.github/workflows/release-packages.yml`](./.github/workflows/release-packages.yml)
  Package release workflow.
- [`.github/workflows/aleph-rootfs-build-publish-deploy.yml`](./.github/workflows/aleph-rootfs-build-publish-deploy.yml)
  Shared Aleph workflow entrypoint.

## How Consumer Repos Use It

The intended consumer model is:

1. keep project-specific contracts, workflow structure, and app behavior in the
   consumer repo
2. install the published package entrypoints from this repo
3. call the Aleph runners from CI

In practice that usually means installing `@le-space/node` and using one or
more of these runner modes:

- `runRootfsMode(...)`
- `runSiteMode(...)`
- `runActionMode(...)`

This keeps Aleph-specific implementation reusable while letting each consumer
repo control its own workflow structure and product-specific behavior.

## Typical Responsibilities

Use this repo when you need reusable support for:

- publishing a qcow2 RootFS image to IPFS and pinning it on Aleph
- creating an Aleph VM instance from a published RootFS
- configuring and verifying an Aleph-hosted relay
- publishing a site with deployment-specific relay bootstrap addresses
- managing retention of older successful Aleph deployments

## Quick Start

```bash
pnpm install
pnpm test
```

Useful commands:

- `pnpm --filter @le-space/core test`
- `pnpm --filter @le-space/node test`
- `pnpm docs:dev`
- `pnpm docs:build`

## Documentation

Docs site:

- https://nikrause.github.io/shared-aleph-tooling/

Source docs live in [docs/docusaurus](./docs/docusaurus).

Useful references:

- [docs/docusaurus/docs/overview/index.md](./docs/docusaurus/docs/overview/index.md)
- [docs/docusaurus/docs/architecture/package-boundaries.md](./docs/docusaurus/docs/architecture/package-boundaries.md)
- [docs/docusaurus/docs/reference/github-action.md](./docs/docusaurus/docs/reference/github-action.md)

## Support

If this repo helps your Aleph, libp2p, or deployment work, you can support it via
[GitHub Sponsors](https://github.com/sponsors/NiKrause).

## Examples And Real Integrations

The `examples/` directory contains thin reference skeletons and integration
shapes. It is not intended to host full production applications.

Canonical real integrations currently include:

- `universal-connectivity`
  - especially the Aleph workflow integration proposed in PR `#344`
- `aleph-libp2p-relay`
  - especially `relay-deployer-pwa` as the browser/PWA integration reference

## Publishing And Setup

- package publishing notes: [PUBLISHING.md](./PUBLISHING.md)
- repository setup notes: [REPOSITORY_SETUP.md](./REPOSITORY_SETUP.md)
- license notes: [LICENSE_DECISION.md](./LICENSE_DECISION.md)
