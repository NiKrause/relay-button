# Package Boundaries

The repository is split so the Aleph domain logic stays reusable while
environment-specific code lives in thin adapters.

## `@shared-aleph/shared-types`

This package should hold only shared contracts and value shapes.

Current examples:

- rootfs manifest types
- Aleph broadcast and deployment result types
- runtime inspection types
- aggregate content types

This package should not know about:

- `process.env`
- GitHub Actions files
- wallet SDKs
- HTTP request execution

## `@shared-aleph/core`

This is the reusable deployment engine.

Current responsibilities:

- manifest validation
- rootfs Aleph `STORE` checks
- CRN discovery and ranking
- Aleph message creation and broadcast helpers
- deployment polling and rejection diagnostics
- runtime inspection
- `uc-go-peer` guest lifecycle helpers
- cleanup and retention logic

This package should depend on injected interfaces such as:

- `fetch`
- message signer
- content hasher
- optional network probes

This package should not directly depend on:

- GitHub Actions output files
- browser wallets
- CLI argument parsing

## `@shared-aleph/node`

This package adapts the shared core for Node and GitHub Actions.

Current responsibilities:

- env parsing
- GitHub output and summary emission
- private-key signing with `ethers`
- deploy plan parsing
- deploy executor composition
- Aleph action runner entrypoint

This package is the correct place for:

- `process.env` access
- GitHub output formatting
- Node-specific crypto or wallet loading

## `@shared-aleph/browser`

This package is reserved for the browser and PWA integration path.

Expected later responsibilities:

- wallet-driven signing
- browser fetch composition
- deployment polling helpers for UI flows
- browser-safe wrappers around the shared core

For now it is intentionally still a scaffold.

## `@shared-aleph/rootfs`

This package will own reusable rootfs build and contract helpers.

Expected later responsibilities:

- manifest creation
- rootfs profile helpers
- reusable guest-script packaging
- build orchestration shared between CI and local tooling

For now it is intentionally still a scaffold.

## GitHub Action And Workflow Layers

The repo also contains two automation entrypoints outside `packages/`:

- `.github/actions/aleph-vm-deploy`
  Shared deploy action backed by `@shared-aleph/node`.
- `.github/workflows/aleph-rootfs-build-publish-deploy.yml`
  Planned reusable workflow that will later compose rootfs build, publish, and
  deploy stages.

The action should stay thin. The reusable logic belongs in packages, not in
large YAML or shell blocks.
