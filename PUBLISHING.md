# Publishing Plan

This repository is expected to publish npm packages from the standalone repo,
but it is not ready to publish yet.

## Recommended First Publish Set

The safest initial publish set is:

- `@shared-aleph/shared-types`
- `@shared-aleph/core`
- `@shared-aleph/node`

Keep these private for now:

- `@shared-aleph/browser`
- `@shared-aleph/rootfs`

Those two still need more real implementation before they should be exposed as
public packages.

## Current Gaps Before Publishing

1. Finalize npm scope and package visibility.
2. Decide the public license for the standalone repo.
3. Add final repository metadata after the GitHub repo exists.
4. Replace the current source-oriented dev entrypoints with publishable `dist/`
   output entrypoints.
5. Define any additional subpath exports that consumers need.
6. Add a release workflow for npm publishing.
7. Decide versioning strategy:
   - one version for all packages
   - or independent package versions
8. Add changelog and release-note generation.

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

These scripts are meant to validate the publish path before we switch the
packages away from their current source-first `main` and `types` fields.

## Confirmed Technical Blockers

The first publish-prep pass surfaced concrete blockers we still need to solve:

1. many source files currently import sibling modules with `.ts` suffixes
2. declaration builds fail on those `.ts` import specifiers
3. local tests currently rely on source-first execution, not built package
   output
4. `@shared-aleph/node` still needs a clean dev-vs-publish strategy for
   consuming `@shared-aleph/core`
5. the shared `core` barrel cleanup work has started, but declaration-build
   compatibility is still not complete

These are good next engineering tasks, but they are not fully solved yet, so
the publish-first packages should remain private for now.

## Suggested Release Order

1. Create the standalone GitHub repository.
2. Set the final package metadata and license.
3. Add npm authentication secrets to the new repo.
4. Publish `@shared-aleph/shared-types`.
5. Publish `@shared-aleph/core`.
6. Publish `@shared-aleph/node`.
7. Update `universal-connectivity` to consume the published packages.

## What Not To Publish Yet

Do not publish the following until their APIs are real:

- browser wallet adapters
- rootfs build package
- placeholder reusable workflow abstractions
