# Package Boundaries

The repository is split so the Aleph domain logic stays reusable while
environment-specific code lives in thin adapters.

Packages use the `@le-space/*` scope.

## `@le-space/shared-types`

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

## `@le-space/core`

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

## `@le-space/node`

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

## `@le-space/browser`

This package is the shared browser and PWA integration layer.

Current responsibilities:

- browser fetch composition
- Aleph API polling and result normalization
- typed browser client surface
- RootFS manifest load and resolution helpers
- pricing fetch helpers
- browser-safe EVM helpers:
  - `ethCall`
  - `sendTransaction`
  - `personalSign`
- browser-safe prepaid vault protocol helpers:
  - chain-id mapping
  - budget formatting
  - vault balance/reservation reads
  - vault transaction helpers

Keep local to apps for now:

- wallet-provider UX and account connection flow
- prepaid enforcement policy and warnings
- UI state and rendering

See also:

- `browser-extraction-plan`

## `@le-space/rootfs`

This package owns reusable RootFS build and contract helpers.

Current responsibilities:

- manifest creation
- RootFS contract parsing
- execution planning
- reusable guest-script and reference asset packaging
- build and publish orchestration used by the Node runner

It is the right package for reusable RootFS-specific logic that should not live
inside consumer repositories.

## GitHub Action And Workflow Layers

The repo also contains two automation entrypoints outside `packages/`:

- `.github/actions/aleph-vm-deploy`
  Shared deploy action backed by `@le-space/node`.
- `.github/workflows/aleph-rootfs-build-publish-deploy.yml`
  Shared workflow entrypoint for RootFS build, publish, and deploy stages.

The action should stay thin. The reusable logic belongs in packages, not in
large YAML or shell blocks.
