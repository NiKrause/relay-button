# Shared Aleph Tooling

`shared-aleph-tooling` is the new source of truth for Aleph VM deployment and
rootfs automation shared between:

- `universal-connectivity`
- `relay-deployer-pwa`

The goal is to keep Aleph-specific logic in one place and leave each consumer
repo with only thin wrappers and app-specific behavior.

## What Exists Today

The repository already contains working shared foundations for:

- shared manifest and runtime types
- rootfs manifest validation
- Aleph `STORE`, `INSTANCE`, `AGGREGATE`, and `FORGET` helper flows
- CRN discovery, ranking, and retry selection
- deployment inspection and polling
- runtime inspection and readiness polling
- `uc-go-peer` guest configuration and verification
- Node-side action runner logic used by GitHub Actions
- a shared `aleph-vm-deploy` GitHub Action

## What Is Still In Progress

Some parts are intentionally still early:

- `@shared-aleph/browser` is scaffold-only
- `@shared-aleph/rootfs` is scaffold-only
- the shared reusable workflow is still a placeholder
- the Docusaurus app itself is not installed yet; these docs currently define
  the content structure and source material

## Repository Shape

- `packages/shared-types`
  Shared contracts used across every package.
- `packages/core`
  Deployment, runtime, CRN, guest, and retention logic that should not depend
  on GitHub Actions, browsers, or Node-specific environment parsing.
- `packages/node`
  Node adapters for private-key signing, GitHub output emission, deploy-plan
  parsing, and the Aleph action runner.
- `packages/browser`
  Reserved for wallet-driven browser flows used by the PWA later.
- `packages/rootfs`
  Reserved for reusable rootfs build and manifest tooling.
- `.github/actions/aleph-vm-deploy`
  Shared GitHub Action wrapper around the Node runner.
- `.github/workflows/aleph-rootfs-build-publish-deploy.yml`
  Planned reusable workflow entrypoint.

## Recommended Reading Order

1. [Package Boundaries](../architecture/package-boundaries.md)
2. [Deployment Lifecycle](../architecture/deployment-lifecycle.md)
3. [GitHub Action Reference](../reference/github-action.md)
4. [Rootfs Contract Reference](../reference/rootfs-contract.md)
5. [Reusable Workflow Reference](../reference/reusable-workflow.md)
