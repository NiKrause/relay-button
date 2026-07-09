# Relay Button

`relay-button` provides reusable Aleph Cloud deployment tooling for
consumer projects that need to:

- build and publish RootFS images
- deploy Aleph VM instances
- publish static sites through Aleph/IPFS
- verify deployed relays and bootstrap addresses
- clean up older Aleph deployment records

This repo is the implementation layer behind Aleph deployment flows used by
consumer projects such as `universal-connectivity`.

## Package Naming

Packages use the `@le-space/*` scope.

For example:

- package: `@le-space/node`

## What Exists Today

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

## What Is Still In Progress

Some parts are still intentionally incomplete:

- `@le-space/browser`
  now published and usable
  still evolving, but already owns shared browser/PWA deployment helpers
- the reusable workflow layer is still evolving
- some docs still describe current direction rather than final public API shape

## Repository Shape

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
  and Sponsor Relay browser flows.
- `packages/rootfs`
  package: `@le-space/rootfs`
  RootFS planning, manifests, reference assets, and build helpers.
- `.github/actions/aleph-vm-deploy`
  Shared GitHub Action wrapper around the Node runner.
- `.github/workflows/aleph-rootfs-build-publish-deploy.yml`
  Relay Button workflow entrypoint.

## Examples And Real Integrations

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

## Recommended Reading Order

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
