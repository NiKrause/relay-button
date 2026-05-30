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
- `@le-space/aleph-bootstrap`
  Aleph-backed relay bootstrap registration and libp2p bootstrap discovery.
- `@le-space/browser`
  Browser-safe Aleph deployment helpers for PWAs and other browser clients.
  Current scope includes Aleph API polling, RootFS resolution, pricing,
  browser EVM helpers, and prepaid vault protocol helpers.
- `@le-space/ui`
  Shared React and Svelte UI components for relay deployment and status flows,
  including the Sponsor Relay browser integration surface.

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

Browser-first consumers may also install:

- `@le-space/browser`
- `@le-space/ui`

## Typical Responsibilities

Use this repo when you need reusable support for:

- publishing a qcow2 RootFS image to IPFS and pinning it on Aleph
- creating an Aleph VM instance from a published RootFS
- configuring and verifying an Aleph-hosted relay
- publishing a site with deployment-specific relay bootstrap addresses
- embedding shared relay deployment UI in React or Svelte apps
- managing retention of older successful Aleph deployments

## Quick Start

```bash
pnpm install
pnpm test
```

Useful commands:

- `pnpm aleph help`
- `pnpm aleph deploy`
- `pnpm aleph rootfs-publish`
- `pnpm exec shared-aleph list-crns | jq`
- `pnpm --filter @le-space/core test`
- `pnpm --filter @le-space/node test`
- `pnpm docs:dev`
- `pnpm docs:build`

Site publishing through `runSiteMode(...)` is Node-native now. Consumer
workflows only need the Aleph CLI environment for the later pin and domain
attach steps, not a separate Python site-upload helper stack.

## Documentation

Docs site:

- https://nikrause.github.io/shared-aleph-tooling/

Source docs live in [docs/docusaurus](./docs/docusaurus).

Useful references:

- [docs/docusaurus/docs/overview/index.md](./docs/docusaurus/docs/overview/index.md)
- [docs/docusaurus/docs/architecture/package-boundaries.md](./docs/docusaurus/docs/architecture/package-boundaries.md)
- [docs/docusaurus/docs/reference/github-action.md](./docs/docusaurus/docs/reference/github-action.md)
- [docs/docusaurus/docs/reference/node-cli.md](./docs/docusaurus/docs/reference/node-cli.md)

## Command Line

You can run the shared Node-side deployment and RootFS flows locally through a
small CLI wrapper:

```bash
pnpm aleph help
pnpm aleph deploy
pnpm aleph rootfs-publish
```

When deploying from the CLI, `ALEPH_VM_REQUIRED_PORTS_JSON` must be a JSON
array of structured port-forward objects, not raw port numbers. See the Node
CLI reference for the working `uc-go-peer` example shape.

You can now also set `ALEPH_VM_ROOTFS_MANIFEST_URL` and let the shared CLI
derive the rootfs item hash, manifest version, disk size, and required
port-forward declarations directly from the published manifest.

For the working OrbitDB relay profile, the shared rootfs runner now supports
the external source checkout directly:

```bash
export ALEPH_ROOTFS_PROJECT_DIR=/path/to/relay-deployer-pwa
export ALEPH_ROOTFS_CONTRACT_PATH=/path/to/shared-aleph-tooling/packages/rootfs/reference/orbitdb-relay-pinner/contract.json
export ALEPH_ROOTFS_ORBITDB_RELAY_PINNER_DIR=/path/to/orbitdb-relay-pinner

pnpm aleph rootfs-build
pnpm aleph rootfs-publish
```

If the image build already succeeded but the later Aleph `STORE` publication
failed, for example due to insufficient Aleph balance, you can retry the
upload/publication step without rebuilding the qcow2:

```bash
export ALEPH_ROOTFS_DRIVER=docker
export ALEPH_ROOTFS_SKIP_BUILD=true
pnpm aleph rootfs-publish
```

The runner now auto-detects `docker` / `virt-customize` when those env flags
are omitted. `ALEPH_ROOTFS_HAS_DOCKER`, `ALEPH_ROOTFS_DOCKER_DAEMON_RUNNING`,
and `ALEPH_ROOTFS_HAS_VIRT_CUSTOMIZE` are still accepted as manual overrides
when you need to force or debug toolchain selection.

This CLI is a thin wrapper around the shared Node runners and uses the same
deployment logic as the shared action/workflow layers.

For machine-readable JSON output without the extra `pnpm run` banner, prefer:

```bash
node ./scripts/aleph-cli.mjs list-crns | jq
```

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
  - including the OrbitDB relay RootFS path where a single public Caddy-backed
    hostname serves HTTPS helper endpoints and secure libp2p WSS transport

## Publishing And Setup

- package publishing notes: [PUBLISHING.md](./PUBLISHING.md)
- repository setup notes: [REPOSITORY_SETUP.md](./REPOSITORY_SETUP.md)
- license notes: [LICENSE_DECISION.md](./LICENSE_DECISION.md)
