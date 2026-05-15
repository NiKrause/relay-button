# Repository Setup

This checklist covers the next external steps after the local standalone repo
has already been created.

## Current Local State

The standalone repository already exists locally and has working history.

Current local commit sequence:

- `d9bdad8` initialize standalone repo
- `7048ddc` package metadata prep
- `83e542e` shared core constant cleanup
- `1e85e66` publish preview pipeline
- `b8def3d` release manifest preparation
- `428aec6` release workflow preparation

## Create The GitHub Repository

Recommended repository name:

- `shared-aleph-tooling`

Recommended initial visibility:

- private first, until license and first publish decisions are final

If you want to create it with the GitHub CLI:

```bash
cd /Users/nandi/Documents/projekte/DecentraSol/shared-aleph-tooling
gh repo create <owner>/shared-aleph-tooling --private --source=. --remote=origin --push
```

If you want the repo commands printed for a specific owner:

```bash
cd /Users/nandi/Documents/projekte/DecentraSol/shared-aleph-tooling
pnpm repo:setup:print -- <owner>
```

If you create it in the GitHub UI instead, run:

```bash
cd /Users/nandi/Documents/projekte/DecentraSol/shared-aleph-tooling
git remote add origin <your-github-repo-url>
git push -u origin main
```

## Configure Repository Settings

Recommended first settings:

- default branch: `main`
- require pull requests for `main`
- require status checks before merge
- keep GitHub Actions enabled

Recommended branch protection checks:

- CI

Recommended repository features:

- Issues: enabled
- Discussions: optional
- Wiki: disabled unless you want separate long-form notes
- Actions: enabled

## Configure Secrets

Required for real npm publishing:

- `NPM_TOKEN`

Recommended GitHub variables or future secrets:

- `NPM_TAG_DEFAULT`
- `NPM_SCOPE`

Recommended before real publish:

- verify npm package ownership on the chosen scope
- verify npm org or user has publish permission

## First Workflow Runs

1. Run `Release Packages` with:
   - `dry_run = true`
   - `npm_tag = next`
2. Download and inspect the generated tarballs.
3. Confirm package names, versions, dependencies, and contents.
4. Only then run a real publish.

## Final Metadata To Set Before First Public Release

- final `license`
- final GitHub repository URL
- `homepage`
- `bugs` URL
- final npm scope decision

## Recommended Initial Commands After Push

```bash
cd /Users/nandi/Documents/projekte/DecentraSol/shared-aleph-tooling
git status
pnpm test
pnpm docs:build
pnpm release:preview
```

Then in GitHub:

1. open the `Release Packages` workflow
2. run it with `dry_run = true`
3. inspect the uploaded tarballs

## First Real Publish Order

1. `@shared-aleph/shared-types`
2. `@shared-aleph/core`
3. `@shared-aleph/node`

Keep these private for now:

- `@shared-aleph/browser`
- `@shared-aleph/rootfs`

## After First Publish

1. update `universal-connectivity` to consume the published packages
2. replace local relative shared tooling paths where appropriate
3. run the shared release workflow again as a dry run after each versioning
   change
