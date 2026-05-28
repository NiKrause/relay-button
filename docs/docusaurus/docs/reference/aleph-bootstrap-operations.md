# Aleph Bootstrap Operations

This page captures the operational facts, live test results, and open
questions around the Aleph-backed bootstrap registry.

It complements the main API-oriented reference at
[`reference/aleph-bootstrap`](./aleph-bootstrap.md).

## Feature Summary

The current bootstrap feature does two things:

1. relay deployment flows publish relay bootstrap multiaddrs to Aleph as
   signed `POST` messages
2. browser and Node libp2p consumers query those posts and build their
   bootstrap list dynamically

Current shared producers:

- GitHub Action VM deploy path
- Sponsor Relay browser UI path

Current shared consumers:

- `universal-connectivity/js-peer`
- `simple-todo`

## Current Write Path

At the moment, bootstrap registration is published through Aleph's HTTP posting
gateway.

That means the signing and message creation are decentralized at the wallet
level, but the message submission step still goes through the current gateway
API instead of directly through Aleph's peer-to-peer message propagation layer.

This is an intentional interim step.

The planned direction is to replace or complement this centralized posting path
with direct publishing into the Aleph P2P message system over the libp2p
network, so relay operators can announce bootstrap data without depending on
the current gateway submission model.

## Research Update

Our current upstream reading suggests the right framing is slightly more
specific than "direct libp2p publishing" alone.

What Aleph clearly documents:

- messages can be submitted to a Core Channel Node gateway
- messages can also be broadcast on the Aleph peer-to-peer network

What Aleph currently exposes in first-party code:

- a dedicated Rust `p2p-service`
- gossipsub-based publish and subscribe support
- HTTP endpoints for `identify` and `dial`
- RabbitMQ exchanges for P2P publish and subscribe bridging

What we did **not** find yet:

- a first-party browser-ready TypeScript SDK for direct Aleph P2P message
  publication
- a source-backed replacement for indexed REST history queries such as
  `posts.json`
- clear proof that raw pubsub publication alone yields the same durable indexed
  message behavior we currently rely on

So the most accurate current plan is:

- short term: keep REST reads and optionally add P2P publication via an
  Aleph-supported bridge
- medium term: test whether P2P publication can coexist with or replace gateway
  submission
- long term: revisit native direct libp2p publication only if Aleph documents
  the exact message topic, protocol, and durable-ingestion expectations we need

## What We Verified

The current implementation has been verified in three layers:

- unit tests for multiaddr filtering and Aleph `POST` construction
- unit tests for bootstrap publication and broadcast behavior
- a live Aleph round-trip test that published dummy public multiaddrs and read
  them back through the public Aleph API

The live test confirmed:

- relay bootstrap `POST` messages can be published successfully
- the posts can be read back through `posts.json`
- no private key is needed for reads
- localhost and private multiaddrs are filtered out before discovery
- browser discovery prefers `browserMultiaddrs` when present

## Public Readability

Bootstrap posts are currently treated as public data.

Operationally, that means:

- anyone who knows the `channel`, `ref`, or message hash can query them
- a different wallet does not need special access to read them
- the signing wallet only matters for proving who wrote the post

This is intentional for bootstrap discovery, because browser apps need a public
read path before they can connect to the relay network.

Right now, that practical public read path is still the REST/indexed API layer,
not a pure libp2p browser subscription flow.

## Freshness Versus Retention

There are two separate concepts here:

### Discovery Freshness

The shared discovery helper currently ignores bootstrap posts older than 7
days.

That is an application-level freshness rule in our code, not a network-level
deletion rule.

This gives us a simple way to avoid very old relay entries without needing any
write-side cleanup first.

### Network Retention

As far as we currently understand it, Aleph messages are not automatically
deleted after 7 days just because our discovery code ignores them.

The current working assumption is:

- bootstrap `POST` messages remain readable until they are explicitly forgotten
  by their sender

This still deserves more precise confirmation against Aleph operational policy,
especially for:

- maximum retention guarantees
- pruning behavior under spam or abuse
- whether relays can rely on indefinite availability of old `POST` records

## Deletion And Abuse Handling

We are not deleting bootstrap posts right now, but it is worth documenting the
current expected control model.

What we currently believe:

- the sender of a bootstrap post should be able to delete it with a `FORGET`
  message
- a third party should not be able to delete another sender's bootstrap post
- if someone spammed a namespace, app-side filtering by freshness and by
  multiaddr validity would reduce some impact, but would not be enough as a
  complete moderation strategy

Questions still worth answering:

- what is the exact Aleph deletion flow for a previously published bootstrap
  `POST`
- how quickly does a forgotten `POST` disappear from `posts.json`
- are there Aleph-side moderation or anti-spam limits we should rely on
- should we add optional allowlists by wallet address, relay profile, or DNS
  suffix for stricter consumer-side filtering

## Recommended Testing

### Local Deterministic Checks

```bash
pnpm --filter @le-space/aleph-bootstrap test
pnpm --filter @le-space/core test
```

### Live Round-Trip Check

```bash
ALEPH_BOOTSTRAP_TEST_PRIVATE_KEY=0xyourkey pnpm test:aleph-bootstrap:live
```

This test:

- publishes dummy public multiaddrs
- includes localhost/private multiaddrs in the write input on purpose
- polls Aleph until the message is readable
- verifies that discovery only returns valid public browser-dialable bootstrap
  addrs

### Public Read Check Without Any Key

After a live test run, the post can be queried without a wallet:

```bash
curl -s "https://api2.aleph.im/api/v0/posts.json?channels=simple-todo&refs=YOUR_REF&types=relay-bootstrap&pagination=10&page=1"
```

or by message hash:

```bash
curl -s "https://api2.aleph.im/api/v0/messages/YOUR_ITEM_HASH"
```

This is the simplest proof that reads are public.

### Future P2P Research Test

A worthwhile next experiment is a Node-only research spike that:

- publishes a signed bootstrap envelope through Aleph `p2p-service`
- subscribes to the same pubsub topic through the bridge
- measures whether the published message later becomes queryable through
  `posts.json`

That experiment would answer the key remaining architecture question:

- is Aleph P2P publication alone enough for our durable bootstrap registry, or
  do we still need the gateway/CCN write path for indexed retrieval

## Open Questions

The main open questions left for this feature are:

1. What is the maximum practical lifetime of a bootstrap `POST` on Aleph if it
   is never forgotten?
2. What exact `FORGET` flow should we document for operators who want to remove
   stale or mistaken bootstrap registrations later?
3. Does P2P publication alone result in the same durable indexed visibility as
   the current REST/CCN submission path?
4. Do we want additional consumer-side anti-spam rules beyond freshness and
   public-multiaddr filtering?
5. Do we want namespace separation per app, per environment, or per relay
   profile instead of one shared `simple-todo` namespace?

## Suggested Next Steps

- keep the current 7-day freshness filter for consumers
- keep live publishing enabled for the relay deployment flows
- research Aleph `p2p-service` as the first realistic bridge toward P2P
  publication
- add one future test that publishes and then forgets a bootstrap `POST`
- add one future test that publishes through the Aleph P2P bridge and compares
  the result with `posts.json`
- decide whether bootstrap consumers should also filter by trusted publisher
  wallet or trusted hostname pattern
- confirm Aleph retention and moderation expectations in upstream docs or with
  the Aleph team
