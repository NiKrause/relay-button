# Publishing Plan

This repository is expected to publish npm packages from the standalone repo,
but it is not ready to publish yet.

## Recommended First Publish Set

The safest initial publish set is:

- `@shared-aleph/shared-types`
- `@shared-aleph/core`
- `@shared-aleph/node`

The release workflow can rewrite those package names to the active npm publish
scope at release time. The preferred default scope is now:

- `@le-space/*`

Keep these private for now:

- `@shared-aleph/browser`
- `@shared-aleph/rootfs`

Those two still need more real implementation before they should be exposed as
public packages.

## Current Gaps Before Publishing

1. Finalize npm scope and package visibility.
2. Confirm the public license for the standalone repo.
3. Add final repository metadata after the GitHub repo exists.
4. Decide versioning strategy:
   - one version for all packages
   - or independent package versions
5. Add changelog and release-note generation.
6. Add npm credentials and provenance-enabled publishing secrets to GitHub.

## Recommended Packaging Approach

- publish only the packages with working, tested implementation
- keep scaffold packages private until they have stable contracts
- generate publishable files into `dist/`
- point `main`, `module`, `types`, and `exports` to `dist/`

## Current Preview Build Path

The repo now has non-destructive preview build scripts for the three likely
first-publish packages:

- `pnpm --filter @shared-aleph/shared-types run build:publish`
- `pnpm --filter @shared-aleph/core run build:publish`
- `pnpm --filter @shared-aleph/node run build:publish`
- `pnpm build:publishable`
- `pnpm publish:prepare`

These scripts are meant to validate the publish path before we switch the
packages away from their current source-first `main` and `types` fields.

`pnpm publish:prepare` now generates publish-ready manifests in:

- `packages/shared-types/dist/package.json`
- `packages/core/dist/package.json`
- `packages/node/dist/package.json`

That keeps the workspace source-first while still proving a realistic npm
publish artifact shape.

The repo also now contains:

- `pnpm release:preview`
- `.github/workflows/release-packages.yml`
- `scripts/publish-from-dist.mjs`

That means the release path is prepared even though public publishing is not yet
enabled.

## Current Status

The publish preview path is now working for:

- `@shared-aleph/shared-types`
- `@shared-aleph/core`
- `@shared-aleph/node`

The packages remain private in source form for now, but the preview release
artifacts and dist-local package manifests build successfully.

The concrete GitHub repo and first-push checklist lives in
[`REPOSITORY_SETUP.md`](./REPOSITORY_SETUP.md).

## Suggested Release Order

1. Create the standalone GitHub repository.
2. Set the final package metadata and confirm the license.
3. Push the release workflow with the standalone repo as source of truth.
4. Add npm authentication secrets to the new repo.
5. Run the workflow once in `dry_run` mode and inspect tarballs.
6. Publish `@shared-aleph/shared-types`.
7. Publish `@shared-aleph/core`.
8. Publish `@shared-aleph/node`.
9. Update `universal-connectivity` to consume the published packages.

## What Not To Publish Yet

Do not publish the following until their APIs are real:

- browser wallet adapters
- rootfs build package
- placeholder reusable workflow abstractions
