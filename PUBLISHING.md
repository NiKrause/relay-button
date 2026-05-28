# Publishing

This repository publishes npm packages under the `@le-space/*` scope.

The release process is already live and is handled through GitHub Actions.

## Current Published Package Set

The currently maintained publishable packages are:

- `@le-space/shared-types`
- `@le-space/aleph-bootstrap`
- `@le-space/core`
- `@le-space/browser`
- `@le-space/node`
- `@le-space/rootfs`
- `@le-space/ui`

## Release Workflow

The canonical release workflow is:

- `.github/workflows/release-packages.yml`

It supports:

- dry-run packaging
- real npm publishing
- configurable npm tag
- configurable npm scope
- optional provenance flag

## Required Secret

Real publishing requires:

- `NPM_TOKEN`

That token must have publish rights for the `@le-space` npm scope.

## Release Model

This repo currently uses aligned package versions across the publishable set.

That means a normal release updates:

- `packages/shared-types/package.json`
- `packages/aleph-bootstrap/package.json`
- `packages/core/package.json`
- `packages/browser/package.json`
- `packages/node/package.json`
- `packages/rootfs/package.json`
- `packages/ui/package.json`

to the same version.

## Local Validation Before Release

Recommended checks before publishing:

```bash
pnpm test
pnpm docs:build
pnpm build:publishable
pnpm publish:prepare
```

Focused package checks:

```bash
pnpm --filter @le-space/shared-types test
pnpm --filter @le-space/aleph-bootstrap test
pnpm --filter @le-space/core test
pnpm --filter @le-space/rootfs test
pnpm --filter @le-space/node test
pnpm --filter @le-space/ui test
```

Optional live Aleph bootstrap round-trip:

```bash
ALEPH_BOOTSTRAP_TEST_PRIVATE_KEY=0xyourkey pnpm test:aleph-bootstrap:live
```

The live test publishes dummy public multiaddrs to Aleph, polls them back via
`posts.json`, and verifies that localhost/private multiaddrs are filtered out.

## Dry Run

Use the GitHub workflow with:

- `dry_run = true`
- `npm_tag = next`
- `npm_scope = le-space`

This produces tarballs without publishing them.

Use dry runs when:

- changing package metadata
- changing `prepare-publish.mjs`
- changing workspace package names
- changing release workflow behavior

## Real Publish

Use the GitHub workflow with:

- `dry_run = false`
- `npm_tag = next` or `latest`
- `npm_scope = le-space`

Typical release flow:

1. bump the package versions
2. validate locally
3. push to `main`
4. run `Release Packages`
5. confirm npm publish succeeded
6. update consumer repos to the new version where needed

## Packaging Model

The repository remains source-first in workspace development, but creates
publishable artifacts into `dist/` before release.

Important helpers:

- `pnpm build:publishable`
- `pnpm publish:prepare`
- `scripts/prepare-publish.mjs`
- `scripts/publish-from-dist.mjs`

## Consumer Follow-Up

After a release, consumer repositories such as `universal-connectivity` may
need to:

1. bump the `@le-space/node` version in workflows
2. bump `@le-space/aleph-bootstrap` in browser/libp2p consumers
3. rerun installs or lockfile refreshes
4. rerun their Aleph workflows
5. verify that the new shared package version behaves correctly end to end

That final consumer validation is especially important after:

- package namespace changes
- release pipeline changes
- rootfs runner changes
- site runner changes
- deployment or retention logic changes
