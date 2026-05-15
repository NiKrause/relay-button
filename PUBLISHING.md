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
4. Replace source-file entrypoints with publishable build outputs.
5. Define package `exports` explicitly.
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
