# Examples And Real Integrations

`relay-button` needs two kinds of documentation around usage:

- thin reference examples
- links to real integrations

Those are related, but they are not the same thing.

## Reference Examples

The `examples/` directory in this repository is for thin reference skeletons
and integration shapes.

Use these when you want to show:

- how a consumer repository calls the shared GitHub Action or workflow
- how a Node consumer uses `@le-space/node`
- how a browser or PWA consumer uses `@le-space/browser`
- how a consumer keeps thin repo-local entrypoints while delegating Aleph
  implementation details to shared tooling

These examples should stay small and contract-focused. They should not become
copies of full production applications.

Current reference example folders include:

- `examples/github-action-consumer`
- `examples/node-deploy`
- `examples/relay-deployer-pwa-consumer`
- `examples/universal-connectivity-wrapper`

## Real Integrations

Real integrations stay in their own repositories and are referenced from docs
as the canonical implementations.

This is important because real integrations usually contain:

- project-specific workflows
- target-specific RootFS profiles
- application-specific UI and policy
- experiments and operational state that do not belong in the shared tooling
  repo

## Current Real Integration References

### `universal-connectivity`

This is the main reference for the shared workflow and deployment integration
pattern around libp2p relay targets such as `go-peer`.

Useful reference points:

- runtime/connectivity PR: `#343`
- Aleph workflow integration PR: `#344`

Use it to understand:

- how a consumer repo keeps its own workflow entrypoints
- how shared runners and actions are called from repo-local workflows
- how project-specific RootFS contracts and relay behavior stay in the consumer
  repo

### `aleph-libp2p-relay`

This is the main reference for the browser and PWA integration path.

Useful reference point:

- `relay-deployer-pwa`

Use it to understand:

- how a browser/PWA keeps app-specific UX local
- how browser-safe deployment logic moves into `@le-space/browser`
- how prepaid and AA-wallet policy can stay local while protocol helpers are
  shared
- how target-specific RootFS profiles can share the same configure -> AutoTLS
  -> metadata lifecycle while keeping daemon-specific bootstrap and proxy
  behavior local
- how the OrbitDB relay target exposes HTTPS helper endpoints through the
  Caddy-backed `2n6` hostname while keeping direct libp2p AutoTLS WSS
  addresses on `*.libp2p.direct`

### `simple-todo`

A peer-to-peer todo list that runs entirely in the browser, written as a
tutorial: ten chapters, each one a complete app with its own Aleph static site
under `*.le-space.de`.

- repository: [Le-Space/simple-todo](https://github.com/Le-Space/simple-todo)
- live: [simple-todo.le-space.de](https://simple-todo.le-space.de); the chapter
  table in the README links the other nine
- the tutorial itself:
  [docs/TUTORIAL.md](https://github.com/Le-Space/simple-todo/blob/main/docs/TUTORIAL.md)

Use it to understand:

- how a SvelteKit app mounts `SponsorRelayFab` from `@le-space/ui/svelte`, so a
  visitor can start a relay of their own from inside the app
- how an app finds the relays registered under its own profile with
  `@le-space/aleph-bootstrap`
- how `@le-space/playwright` gives each end-to-end spec a relay of its own
- how one workflow publishes ten sites with the `@le-space/node` site mode and
  links each of them to its custom domain

### `belege`

Local-first receipt matching: bank and crypto transactions, e-mail, DATEV
export. The books live in OrbitDB in the browser; the app itself is published
as an Aleph static site.

- repository: [Le-Space/belege](https://github.com/Le-Space/belege)
- live: [belege.le-space.de](https://belege.le-space.de)

Use it to understand how an app that is not about relays at all still ships
through the shared tooling: its deploy workflow runs the `@le-space/node` site
mode and points the custom domain at the result, and nothing from
`relay-button` is in the app bundle.

### `ablage`

A folder that stays the same on two devices. No account, nothing in the middle.

- repository: [Le-Space/ablage](https://github.com/Le-Space/ablage)
- live: [ablage.le-space.de](https://ablage.le-space.de)

Use it to understand:

- how `@le-space/aleph-bootstrap` is one relay source among several: loaded
  lazily, and filtered by profile and registration id before anything is
  dialled
- how the same site-mode deploy publishes the app and links its domain

## What Does Not Belong In `examples/`

Do not move full production apps into `relay-button/examples/` just to
have “examples” in one repo.

For example:

- `relay-deployer-pwa` should remain in its own integration repo
- `universal-connectivity` should remain in its own integration repo

Those repos are better treated as canonical references than as copied example
trees.

## Future Integration References

As more projects adopt the shared tooling, they should be linked here as real
integration references.

Likely candidates include:

- `orbitdb-relay`
- `qauld`
- Bitsocial daemon and related web client flows

Each of those should only be added once they actually use the shared tooling in
a meaningful way.
