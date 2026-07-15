# Relay Button

*Local-first peer-to-peer apps you can keep, share, and use without depending
on a permanent cloud backend.*

Thirty years ago, software came on a CD. You owned a copy, installed it locally,
and could continue using it without asking a vendor's server for permission.

Relay Button brings this idea to modern web applications. A local-first
peer-to-peer Progressive Web App (PWA) can be hosted on IPFS, downloaded
directly, or even shared on a USB drive. The application and its primary data
remain on the user's device instead of living exclusively in a cloud database.

> **Terminology:** "Local-first" alone does not imply peer-to-peer or
> server-free operation. Many local-first applications still use central
> servers for synchronization and collaboration. Relay Button specifically
> targets **local-first peer-to-peer applications**, where primary data stays
> local and collaboration data can replicate directly between peers.

When people want to collaborate, their apps exchange and replicate data over
peer-to-peer connections. A chat, shared todo list, or collaborative workspace
therefore does not need a conventional central application server.

Real-world peer-to-peer networks still need some supporting infrastructure.
Devices behind firewalls or changing networks need help finding and reaching
each other. Teams may also want an online IPFS node that keeps shared data
available while individual devices are offline.

This is what the Relay Button is for: start a signaling and bootstrap relay
when collaboration or automatic IPFS pinning needs it. Keep it running for a
meeting, a project, or for years—and stop it when it is no longer useful.

Today, Relay Button deploys OrbitDB and libp2p relay services on Aleph Cloud.
The relay helps peers connect and can pin shared data, but it does not become
the owner of the application or its primary data. For longer-term retention,
decentralized archival storage such as Filecoin can be added separately.

## What Happens When You Press the Button?

1. The PWA and its data already work locally on the user's device.
2. Relay Button starts an internet-reachable OrbitDB and libp2p relay.
3. Peers use the relay to discover each other and establish communication.
4. The applications replicate their data peer-to-peer in real time.
5. The relay can pin shared IPFS data while team devices are offline.
6. When the shared infrastructure is no longer needed, it can be stopped.

The current repository contains the reusable UI, browser libraries, deployment
runners, and automation behind this flow. The implementation currently targets
Aleph Cloud while keeping the local-first peer-to-peer application independent
from a permanent cloud backend.

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
  including the Relay Button browser integration surface.

### GitHub Automation

- [`.github/actions/aleph-vm-deploy/action.yml`](./.github/actions/aleph-vm-deploy/action.yml)
  GitHub Action wrapper for Aleph VM deployment operations.
- [`.github/workflows/release-packages.yml`](./.github/workflows/release-packages.yml)
  Package release workflow.
- [`.github/workflows/aleph-rootfs-build-publish-deploy.yml`](./.github/workflows/aleph-rootfs-build-publish-deploy.yml)
  Relay Button workflow entrypoint.
- [`.github/workflows/aleph-rs-llm-review.yml`](./.github/workflows/aleph-rs-llm-review.yml)
  Optional LLM-assisted comparison of selected Relay Button integrations with
  the current upstream `aleph-rs` Rust client. The workflow is manual-only for
  now, so it does not run on pushes or on a schedule. It can be activated from
  the GitHub Actions **Run workflow** menu after configuring the
  `OPENAI_COMPAT_API_KEY` secret and the `OPENAI_COMPAT_BASE_URL` and
  `OPENAI_COMPAT_MODEL` repository variables. Scheduled or path-based drift
  monitoring can be restored later by adding `schedule` or `push` triggers.

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

- `pnpm relay-button help`
- `pnpm relay-button deploy`
- `pnpm relay-button rootfs-publish`
- `pnpm exec relay-button list-crns | jq`
- `pnpm --filter @le-space/core test`
- `pnpm --filter @le-space/node test`
- `pnpm docs:dev`
- `pnpm docs:build`

Site publishing through `runSiteMode(...)` is Node-native now. Consumer
workflows only need the Aleph CLI environment for the later pin and domain
attach steps, not a separate Python site-upload helper stack.

## Documentation

Docs site:

- https://nikrause.github.io/relay-button/

Source docs live in [docs/docusaurus](./docs/docusaurus).

Useful references:

- [docs/docusaurus/docs/overview/index.md](./docs/docusaurus/docs/overview/index.md)
- [docs/docusaurus/docs/architecture/package-boundaries.md](./docs/docusaurus/docs/architecture/package-boundaries.md)
- [docs/docusaurus/docs/reference/github-action.md](./docs/docusaurus/docs/reference/github-action.md)
- [docs/docusaurus/docs/reference/node-cli.md](./docs/docusaurus/docs/reference/node-cli.md)

### Aleph Bootstrap Docs

If you want the detailed story for `@le-space/aleph-bootstrap`, start here:

- [packages/aleph-bootstrap/README.md](./packages/aleph-bootstrap/README.md)
  Package purpose, exported API, default namespace, and discovery trust modes.
- [docs/docusaurus/docs/reference/aleph-bootstrap.md](./docs/docusaurus/docs/reference/aleph-bootstrap.md)
  Detailed registration and discovery flow, signing model, freshness rules, and validation.
- [docs/docusaurus/docs/reference/aleph-bootstrap-operations.md](./docs/docusaurus/docs/reference/aleph-bootstrap-operations.md)
  Cleanup behavior, `FORGET` usage, retention uncertainty, spam risk, and open weaknesses.

Current operational summary:

- discovery ignores records older than 7 days, but that is only an app-side freshness rule
- actual cleanup is sender-driven through Aleph `FORGET` messages
- deploy-time and refresh-time flows can forget older self-owned records when a stable `registrationId` is available
- legacy wallet-signed records are still accepted by default unless consumers require dual-key attestation
- the shared namespace should currently be treated as publicly writable, so consumer-side filtering still matters

## RootFS Workflow Artifact URLs

The shared reusable RootFS workflow now exposes manifest artifact links both in
its job summary and as reusable workflow outputs.

Consumer repos now get:

- a published IPFS CID for the manifest JSON itself
- an Aleph IPFS gateway URL for that manifest JSON
- a GitHub artifact page URL for the uploaded RootFS manifest bundle
- a GitHub API ZIP URL for that artifact
- the uploaded manifest paths echoed in the workflow summary

This helps when the RootFS image has already been published to Aleph/IPFS and
the manifest JSON also needs a reusable fetch URL.

Current limitation:

- the artifact URLs still point to GitHub Actions artifact storage, so they
  follow GitHub artifact access and retention rules

## Command Line

You can run the shared Node-side deployment and RootFS flows locally through a
small CLI wrapper:

```bash
pnpm relay-button help
pnpm relay-button deploy
pnpm relay-button rootfs-publish
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
export ALEPH_ROOTFS_CONTRACT_PATH=/path/to/relay-button/packages/rootfs/reference/orbitdb-relay/contract.json
export ALEPH_ROOTFS_ORBITDB_RELAY_DIR=/path/to/orbitdb-relay

pnpm relay-button rootfs-build
pnpm relay-button rootfs-publish
```

For Rust CLI-equivalent IPFS publication, set
`ALEPH_ROOTFS_UPLOAD_DRIVER=aleph-api-ipfs`. This computes the rootfs CID
locally, sends the signed `STORE` metadata with the file to
`/api/v0/ipfs/add_file`, and avoids a later standalone pin request.

If the image build already succeeded but the later Aleph `STORE` publication
failed, for example due to insufficient Aleph balance, you can retry the
upload/publication step without rebuilding the qcow2:

```bash
export ALEPH_ROOTFS_DRIVER=docker
export ALEPH_ROOTFS_SKIP_BUILD=true
pnpm relay-button rootfs-publish
```

The runner now auto-detects `docker` / `virt-customize` when those env flags
are omitted. `ALEPH_ROOTFS_HAS_DOCKER`, `ALEPH_ROOTFS_DOCKER_DAEMON_RUNNING`,
and `ALEPH_ROOTFS_HAS_VIRT_CUSTOMIZE` are still accepted as manual overrides
when you need to force or debug toolchain selection.

This CLI is a thin wrapper around the shared Node runners and uses the same
deployment logic as the shared action/workflow layers.

For machine-readable JSON output without the extra `pnpm run` banner, prefer:

```bash
pnpm exec relay-button list-crns | jq
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
  - including the OrbitDB relay RootFS path where the Caddy-backed `2n6`
    hostname serves HTTPS helper endpoints while direct libp2p AutoTLS WSS
    addresses are advertised on `*.libp2p.direct`

## Publishing And Setup

- package publishing notes: [PUBLISHING.md](./PUBLISHING.md)
- repository setup notes: [REPOSITORY_SETUP.md](./REPOSITORY_SETUP.md)
- license notes: [LICENSE_DECISION.md](./LICENSE_DECISION.md)
