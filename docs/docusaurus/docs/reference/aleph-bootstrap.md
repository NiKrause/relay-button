# Aleph Bootstrap

`@le-space/aleph-bootstrap` is the shared package for relay bootstrap
registration and discovery on Aleph.

It covers two sides of the flow:

1. relay deployment paths publish fresh public multiaddrs as Aleph `POST`
   messages
2. browser or Node libp2p apps query those posts before creating their
   bootstrap peer discovery service

## Default Namespace

The current shared namespace is:

- channel: `simple-todo`
- ref: `simple-todo-bootstrap`
- post type: `relay-bootstrap`

These defaults are exported, but every value can be overridden when a consumer
needs an app-specific namespace.

## Relay Registration

The shared deploy flows now register bootstrap addresses automatically for the
`uc-go-peer` and `orbitdb-relay-pinner` RootFS profiles when they are launched
through:

- the shared GitHub Action VM deploy path
- the Sponsor Relay browser UI path

The registration payload stores:

- `peerId`
- `multiaddrs`
- `browserMultiaddrs`
- `profile`
- `version`
- `updatedAt`

Only public multiaddrs are published. Loopback, RFC1918, link-local, and
localhost-style addresses are filtered out before the Aleph `POST` is signed.

### Current Transport Reality

Today, `shared-aleph-tooling` submits those signed Aleph `POST` messages
through Aleph's HTTP/Core Channel Node gateway.

Aleph's platform documentation also describes peer-to-peer message broadcast as
another supported transport, but the practical first-party integration surface
we found for that path is Aleph's separate `p2p-service` bridge rather than a
browser-ready TypeScript SDK.

That means the current implementation should be understood as:

- decentralized at the wallet-signing layer
- gateway-based at submission time
- public and REST-queryable at read time

## App Discovery

Typical discovery looks like this:

```ts
import { createLibp2pAlephBootstrap } from '@le-space/aleph-bootstrap'

const alephBootstrap = await createLibp2pAlephBootstrap()
```

If an app wants only the raw multiaddr list, call:

```ts
import { discoverAlephBootstrapMultiaddrs } from '@le-space/aleph-bootstrap'

const list = await discoverAlephBootstrapMultiaddrs()
```

By default, discovery:

- queries `https://api2.aleph.im/api/v0/posts.json`
- loads the shared `relay-bootstrap` posts
- skips entries older than 7 days
- deduplicates the returned multiaddrs
- prefers `browserMultiaddrs` when available

## Validation

The shared monorepo now has two validation layers for this flow:

- local unit coverage in `packages/aleph-bootstrap/test` and
  `packages/core/test/bootstrap-registration.test.ts`
- an opt-in live round-trip script at `scripts/test-aleph-bootstrap-live.mjs`

Run the deterministic local checks with:

```bash
pnpm --filter @le-space/aleph-bootstrap test
pnpm --filter @le-space/core test
```

Run the live Aleph round-trip with a funded or otherwise valid wallet key:

```bash
ALEPH_BOOTSTRAP_TEST_PRIVATE_KEY=0xyourkey pnpm test:aleph-bootstrap:live
```

The live check:

- publishes dummy public multiaddrs into Aleph as a `relay-bootstrap` `POST`
- polls `posts.json` until the just-published post is visible
- re-runs discovery through `discoverAlephBootstrapMultiaddrs()`
- verifies that private and localhost multiaddrs were filtered out

## P2P Direction

The current architectural direction is not to replace REST reads immediately,
but to investigate a hybrid model:

- P2P or P2P-bridge publication for live bootstrap announcements
- REST `posts.json` discovery for startup, history, pagination, and browser
  backfill

This is based on the current Aleph ecosystem shape:

- Aleph documents P2P broadcast as a supported message transport
- Aleph maintains a Rust `p2p-service` that exposes gossipsub publication and
  subscription over HTTP and RabbitMQ
- we do not yet have source-backed evidence that raw pubsub alone gives us the
  same durable indexed behavior as the current REST/CCN write path

## Remaining Requirements

The main requirements and caveats left for end-to-end live validation are:

- an EVM private key available as `ALEPH_BOOTSTRAP_TEST_PRIVATE_KEY` or
  `ALEPH_PRIVATE_KEY`
- small indexing delay on Aleph before a newly published `POST` appears in
  `posts.json`
- dedicated `channel` and `ref` values if you want isolation from the shared
  `simple-todo` namespace during testing
- browser consumers still need their own project-level checks because bootstrap
  discovery can be correct while unrelated app type errors still exist

## Consumer Notes

`universal-connectivity/js-peer` and `simple-todo` should use this package in
place of hardcoded bootstrap multiaddrs or direct `@libp2p/bootstrap` static
lists.
