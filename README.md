# Relay Button

*Local-first peer-to-peer apps you can keep, share, and use without depending
on a permanent cloud backend.*

A local-first peer-to-peer app still needs some infrastructure: devices behind
firewalls need help finding each other, and shared data needs somewhere to stay
available while everyone is offline. Relay Button is a button you put in your
app that starts exactly that — an internet-reachable libp2p and OrbitDB relay on
Aleph Cloud, paid from the user's own credits, and stopped again when the
collaboration is over.

The relay helps peers connect and can pin shared data. It never becomes the
owner of the app or its primary data.

**[Read the documentation →](https://nikrause.github.io/relay-button/)**
 · [Why this exists](./docs/docusaurus/docs/overview/index.md)
 · [Getting started](./docs/docusaurus/docs/getting-started.md)

## Quick start

Embedding the button takes one dependency and one component:

```bash
npm install @le-space/ui
```

```svelte
<script>
  import SponsorRelayFab from '@le-space/ui/svelte'
</script>

<SponsorRelayFab manifestUrl="https://example.com/rootfs-manifest.json" />
```

React, props, theming, and driving the controller yourself are in
[Embed the Relay Button](./docs/docusaurus/docs/reference/ui.md). Deploying from
CI instead of a browser is in
[GitHub Action](./docs/docusaurus/docs/reference/github-action.md).

> Pin a version. Releases are published under `next` and promoted to `latest`
> after consumer testing, so which tag is newer depends on where a release is
> in that cycle. `npm view @le-space/ui dist-tags` answers it for today.

## Packages

All published under the `@le-space/*` scope.

| Package | What it owns | Reference |
| --- | --- | --- |
| `shared-types` | Types and contracts shared across the workspace | — |
| `core` | Deployment, runtime, CRN, guest and retention logic. Runs in Node and the browser | [Core](./docs/docusaurus/docs/reference/core.md) |
| `browser` | Browser-safe Aleph API, wallet transport, pricing, credits | [Browser](./docs/docusaurus/docs/reference/browser.md) |
| `ui` | React and Svelte deployment UI | [UI](./docs/docusaurus/docs/reference/ui.md) |
| `node` | Node entrypoints and GitHub Actions adapters | [Node CLI](./docs/docusaurus/docs/reference/node-cli.md) |
| `rootfs` | RootFS planning, manifests, reference profile assets | [Rootfs contract](./docs/docusaurus/docs/reference/rootfs-contract.md) |
| `aleph-bootstrap` | Relay bootstrap registration and discovery | [Aleph bootstrap](./docs/docusaurus/docs/reference/aleph-bootstrap.md) |
| `playwright` | Reusable Playwright fixtures and relay lifecycle helpers | [Playwright testkit](./docs/docusaurus/docs/reference/playwright-testkit.md) |

How the layers are allowed to depend on each other, and what belongs in your app
rather than here, is in
[Package Boundaries](./docs/docusaurus/docs/architecture/package-boundaries.md).

## Working on this repo

```bash
pnpm install
pnpm test
```

| Command | Does |
| --- | --- |
| `pnpm test` | Every package's test suite |
| `pnpm --filter @le-space/core test` | One package |
| `pnpm docs:dev` | Docs site with live reload |
| `pnpm docs:build` | Docs build — fails on broken links |
| `pnpm relay-button help` | The CLI wrapper around the Node runners |
| `pnpm exec relay-button list-crns \| jq` | Machine-readable output, no `pnpm run` banner |

## GitHub automation

- [`.github/actions/aleph-vm-deploy`](./.github/actions/aleph-vm-deploy/action.yml) — VM deployment action
- [`.github/workflows/aleph-rootfs-build-publish-deploy.yml`](./.github/workflows/aleph-rootfs-build-publish-deploy.yml) — the workflow entrypoint consumers call
- [`.github/workflows/release-packages.yml`](./.github/workflows/release-packages.yml) — package release
- [`.github/workflows/promote-npm-dist-tag.yml`](./.github/workflows/promote-npm-dist-tag.yml) — `next` → `latest`

The reusable workflow's inputs, outputs and artifact URLs are documented in
[Reusable workflow](./docs/docusaurus/docs/reference/reusable-workflow.md).

## Notes

- package publishing: [PUBLISHING.md](./PUBLISHING.md)
- repository setup: [REPOSITORY_SETUP.md](./REPOSITORY_SETUP.md)
- license: [LICENSE_DECISION.md](./LICENSE_DECISION.md)
- roadmap and release notes: [ROADMAP.md](./ROADMAP.md)

## Support

If this repo helps your Aleph, libp2p, or deployment work, you can support it
via [GitHub Sponsors](https://github.com/sponsors/NiKrause).
