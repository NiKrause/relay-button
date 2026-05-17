# Repository Setup

This document describes the current external setup for
`NiKrause/shared-aleph-tooling`.

It is meant for maintainers who need to understand which GitHub and npm pieces
must exist for the repo to build docs, release packages, and support consumer
repositories such as `universal-connectivity`.

## Current Repository State

The repository already exists on GitHub:

- `https://github.com/NiKrause/shared-aleph-tooling`

Current supporting services are already in use:

- GitHub Actions for CI, release, and docs deployment
- GitHub Pages for published docs
- npm publishing under the `@le-space/*` scope

## Current GitHub Settings

Recommended and currently expected settings:

- default branch: `main`
- GitHub Actions: enabled
- GitHub Pages: enabled
- GitHub Pages source: `GitHub Actions`

Recommended repository features:

- Issues: enabled
- Discussions: optional
- Wiki: optional

Recommended branch protection for `main`:

- require pull requests before merge
- require status checks before merge
- keep direct pushes limited to maintainers

## Required Secrets

For real npm publishing:

- `NPM_TOKEN`

This token must be able to publish to the `@le-space` npm scope.

## Current Package Scope

The workspace and published package names now use the same scope:

- `@le-space/shared-types`
- `@le-space/core`
- `@le-space/node`
- `@le-space/rootfs`

Not yet released:

- `@le-space/browser`

## Current Published Docs

The Docusaurus site is published via GitHub Pages at:

- `https://nikrause.github.io/shared-aleph-tooling/`

The Pages deployment is handled by:

- `.github/workflows/docs-pages.yml`

## Current Release Workflow

Packages are released through:

- `.github/workflows/release-packages.yml`

Typical release inputs:

- `dry_run`
- `npm_tag`
- `npm_scope`
- `provenance`

Current default publish scope:

- `le-space`

## Maintainer Checklist

When bringing up a new maintainer environment or verifying repo health:

1. Confirm GitHub Actions are enabled.
2. Confirm GitHub Pages is enabled and still points to GitHub Actions.
3. Confirm `NPM_TOKEN` is present and valid.
4. Confirm the npm account still has publish rights for `@le-space`.
5. Run the docs workflow after major docs changes.
6. Run the release workflow in `dry_run=true` before changing the release path.

## Useful Local Validation Commands

```bash
pnpm test
pnpm docs:build
pnpm build:publishable
pnpm publish:prepare
```

Useful focused checks:

```bash
pnpm --filter @le-space/core test
pnpm --filter @le-space/node test
pnpm --filter @le-space/rootfs test
pnpm --filter @le-space/shared-types test
```

## Consumer Repository Expectation

Consumer repositories are expected to:

1. install published packages such as `@le-space/node`
2. keep project-specific contracts and workflow structure locally
3. call Aleph runner entrypoints from their own workflows

That is the current preferred integration pattern.
