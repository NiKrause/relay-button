# Contributing

This repository is a shared monorepo for Aleph tooling used by multiple
consumers. The main rule is simple:

- put reusable Aleph logic in shared packages
- keep consumer-specific behavior out of shared code unless there is a clear,
  approved reason to generalize it

## Package Boundaries

- `packages/shared-types`
  Shared contracts only.
- `packages/core`
  Runtime-agnostic deployment and inspection logic.
- `packages/node`
  Node, GitHub Actions, and private-key execution adapters.
- `packages/browser`
  Future browser and wallet adapters.
- `packages/rootfs`
  Future reusable rootfs and guest-script packaging logic.

If a feature needs `process.env`, GitHub output files, or Node-only wallet
loading, it likely belongs in `@shared-aleph/node`, not `@shared-aleph/core`.

## Local Validation

Run the shared checks before opening a PR:

```bash
pnpm test
pnpm docs:build
```

Targeted checks:

```bash
pnpm --filter @shared-aleph/core test
pnpm --filter @shared-aleph/node test
pnpm --dir docs/docusaurus build
```

## Working Style

- prefer small, composable core functions
- inject `fetch`, signers, and hashers into core logic
- avoid adding repo-local shell logic when the behavior belongs in a package
- keep docs in sync with real implementation state
- do not silently move consumer-specific behavior into shared scope

## Scope Discipline

Current approved shared scope:

- `uc-go-peer`
- shared deploy action logic
- shared retention cleanup
- shared deployment diagnostics and runtime inspection

Explicitly deferred for now:

- prepaid and AA-wallet PWA behavior
- legacy profiles from `relay-deployer-pwa`
- full shared rootfs workflow parity
