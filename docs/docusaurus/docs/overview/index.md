# Relay Button

*Collaboration should not disappear when a cloud provider, account, or data
center does.*

## Software You Can Keep

Thirty years ago, software came on a CD. You owned a copy, installed it locally,
and could continue using it without asking a vendor's server for permission.

Relay Button brings this idea to modern web applications. A local-first
peer-to-peer Progressive Web App (PWA) can be hosted on IPFS, downloaded from
another source, or passed from one person to another on offline media such as a
USB drive. The application and its primary working data stay on the user's
device.

Apps such as chats, shared todo lists, and collaborative workspaces can then
exchange and replicate changes directly over peer-to-peer connections. They do
not need to send every interaction through a central cloud database.

:::note Terminology

"Local-first" alone does not mean peer-to-peer or server-free. Many local-first
applications still depend on central servers for synchronization and
collaboration. These docs use **local-first peer-to-peer application** for the
specific combination Relay Button supports: primary data stays local, while
collaboration data can replicate directly between peers.

:::

## Why a Peer-to-Peer App Still Needs a Relay

"Peer-to-peer" does not mean that internet infrastructure magically
disappears. Devices are often behind firewalls, move between networks, or go
offline. Peers therefore need a practical way to discover and reach each other.

A **signaling or bootstrap relay** provides that introduction. It helps peers
find a route to one another so their apps can communicate and replicate data.
An online **IPFS pinning node** can additionally keep selected shared content
available while individual team devices are offline.

These services support the application, but they are not the application's
permanent backend and do not have to own its primary data.

## What Happens When You Press the Relay Button?

1. The PWA and its local data are already available on the user's device.
2. Relay Button deploys an internet-reachable OrbitDB and libp2p relay.
3. The relay publishes the addresses that peers need for discovery.
4. Team members' apps connect and replicate their data peer-to-peer in real
   time.
5. The relay can pin selected IPFS data when additional availability is useful.
6. The deployment can run for minutes, months, or years—and be stopped when it
   is no longer needed.

The current implementation deploys this relay infrastructure on Aleph Cloud.
The local-first peer-to-peer PWA remains distributable through IPFS, a normal
download, or offline media and is not tied to that deployment for its basic
local use.

## From Local Data to a Durable Archive

Peer-to-peer replication and IPFS pinning improve availability, but they are
not automatically a permanent archive. Data that must survive beyond
individual devices and temporary relays can also be written to decentralized
archival storage such as Filecoin.

This creates a layered model:

- **local-first:** the working copy belongs to the user and remains usable
  locally, whether or not an application also uses servers
- **peer-to-peer:** collaborators can exchange and replicate changes directly
- **relay on demand:** temporary infrastructure helps peers connect and keeps
  selected data online
- **decentralized archive:** optional long-term storage preserves data beyond
  the lifetime of devices and relays

The goal is not to pretend that infrastructure disappears. The goal is to make
it optional, replaceable, and controlled by the people using the application.

## Developer Guide

This repository provides the reusable React and Svelte UI, browser libraries,
Node runners, RootFS tooling, and GitHub automation behind the Relay Button.
The implementation layer is currently Aleph-specific and is used by consumer
projects such as `universal-connectivity`.

### Package Naming

Packages use the `@le-space/*` scope.

For example:

- package: `@le-space/node`

### What Exists Today

The repository currently contains working Aleph-specific support for:

- shared manifest and runtime types
- Aleph-backed relay bootstrap registration and discovery
- RootFS planning and publish helpers
- Aleph `STORE`, `INSTANCE`, `AGGREGATE`, and `FORGET` flows
- CRN discovery, ranking, and retry selection
- deployment inspection and polling
- runtime inspection and readiness polling
- `uc-go-peer` guest configuration and verification
- Node-side Aleph runners used by GitHub Actions
- a shared `aleph-vm-deploy` GitHub Action
- a local Node CLI wrapper for the same shared runner paths

### What Is Still In Progress

Some parts are still intentionally incomplete:

- `@le-space/browser`
  now published and usable
  still evolving, but already owns shared browser/PWA deployment helpers
- the reusable workflow layer is still evolving
- some docs still describe current direction rather than final public API shape

### Repository Shape

- `packages/shared-types`
  package: `@le-space/shared-types`
  Shared contracts used across every package.
- `packages/core`
  package: `@le-space/core`
  Deployment, runtime, CRN, guest, and retention logic that should not depend
  on GitHub Actions, browsers, or Node-specific environment parsing.
- `packages/aleph-bootstrap`
  package: `@le-space/aleph-bootstrap`
  Shared relay bootstrap registration and Aleph-backed bootstrap discovery.
- `packages/node`
  package: `@le-space/node`
  Node adapters and Aleph runner entrypoints for CI and automation.
- `packages/browser`
  package: `@le-space/browser`
  Browser-safe Aleph deployment helpers for PWAs and other browser clients.
  Current scope includes API polling, RootFS resolution, pricing, browser EVM
  helpers, and prepaid vault protocol helpers.
- `packages/ui`
  package: `@le-space/ui`
  Shared React and Svelte UI components for relay deployment, status display,
  and Relay Button browser flows.
- `packages/rootfs`
  package: `@le-space/rootfs`
  RootFS planning, manifests, reference assets, and build helpers.
- `.github/actions/aleph-vm-deploy`
  Shared GitHub Action wrapper around the Node runner.
- `.github/workflows/aleph-rootfs-build-publish-deploy.yml`
  Relay Button workflow entrypoint.

### Examples And Real Integrations

The `examples/` directory is for thin reference skeletons and integration
shapes. It should not become a home for copied full applications.

Real integrations stay in their own repositories and are linked from docs as
canonical references.

Current real references include:

- `universal-connectivity`
  - especially the Aleph integration work in PR `#344`
- `aleph-libp2p-relay`
  - especially `relay-deployer-pwa` as the browser/PWA reference consumer

See also:

- [Examples And Real Integrations](../architecture/examples-and-integrations.md)
- [Browser Guest Setup Refactor Plan](../architecture/browser-guest-setup-refactor-plan.md)

### Recommended Reading Order

1. [Package Boundaries](../architecture/package-boundaries.md)
2. [Examples And Real Integrations](../architecture/examples-and-integrations.md)
3. [Browser Guest Setup Refactor Plan](../architecture/browser-guest-setup-refactor-plan.md)
4. [Deployment Lifecycle](../architecture/deployment-lifecycle.md)
5. [Aleph Bootstrap Reference](../reference/aleph-bootstrap.md)
6. [Aleph Bootstrap Operations](../reference/aleph-bootstrap-operations.md)
7. [UI Package Reference](../reference/ui.md)
8. [Node CLI Reference](../reference/node-cli.md)
9. [GitHub Action Reference](../reference/github-action.md)
10. [Rootfs Contract Reference](../reference/rootfs-contract.md)
11. [Reusable Workflow Reference](../reference/reusable-workflow.md)
