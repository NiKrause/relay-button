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

- GitHub Action VM deploy path in
  [`relay-button`](https://github.com/NiKrause/relay-button)
- Sponsor Relay browser UI path in
  [`relay-button`](https://github.com/NiKrause/relay-button)

Current shared consumers:

- [`universal-connectivity/js-peer`](https://github.com/NiKrause/universal-connectivity/tree/main/js-peer)
- [`simple-todo`](https://github.com/NiKrause/simple-todo)

Current shared deployment/rootfs profiles:

- [`uc-go-peer`](https://github.com/NiKrause/relay-button/tree/main/packages/rootfs/reference/uc-go-peer)
- [`orbitdb-relay`](https://github.com/NiKrause/relay-button/tree/main/packages/rootfs/reference/orbitdb-relay)
  for [`NiKrause/orbitdb-relay`](https://github.com/NiKrause/orbitdb-relay)
- [`ucan-store`](https://github.com/NiKrause/relay-button/tree/main/packages/rootfs/reference/ucan-store)
  for [`NomadKids/ucan-store`](https://github.com/NomadKids/ucan-store)

`ucan-store` is listed here as a shared deployment profile, not as a
relay-bootstrap producer. Its public discovery path is service metadata, not
relay multiaddr registration posts.

## Current Versus Target Trust Model

Current implementation:

- legacy bootstrap `POST`s are still possible and remain wallet-signed
- dual-key bootstrap `POST`s are supported and readers can verify them
- both `uc-go-peer` and `orbitdb-relay` can now preseed their libp2p
  secp256k1 identity from publisher key `B`, so the relay `peerId` and Aleph
  publisher identity share the same cryptographic root when that key is
  supplied
- `orbitdb-relay` still keeps its older Ed25519-generated fallback when
  no publisher key `B` is supplied

Target implementation:

- owner key `A` is the deployment wallet
- relay key `B` is a separate key stored in the relay VM
- owner key `A` signs an authorization for relay key `B`
- relay key `B` signs the bootstrap payload it republishes
- readers verify both signatures before trusting the record

This dual-key model is now the intended direction for the feature. Older
competing ideas such as "single key for everything", "derived child key
recognized by Aleph", or "Aleph publish-on-behalf as the primary trust model"
should be treated as superseded design exploration rather than the active
plan.

## Current Write Path

Bootstrap registration is currently published through Aleph's HTTP posting
gateway.

That means the signing and message creation are decentralized at the wallet
level, but the message submission step still goes through the current gateway
API instead of directly through Aleph's peer-to-peer message propagation layer.

This is still an interim step. The best documented future direction today is
not yet "direct browser libp2p publishing" by itself, but rather some
combination of:

- Aleph-supported P2P bridge tooling such as `p2p-service`
- continued REST/indexed reads for browser startup discovery
- and a relay-side dual-key refresh model once reader verification is in place

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
- republishing the same relay identity can request `FORGET` for older records
- the posts can be read back through `posts.json`
- no private key is needed for reads
- localhost and private multiaddrs are filtered out before discovery
- browser discovery prefers `browserMultiaddrs` when present
- a fresh random ephemeral wallet key was also able to publish, republish, and
  forget bootstrap `POST` records in practice

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

### Double-Checked Retention Status

We double-checked the current Aleph documentation again before writing this
note.

What is clear from the docs:

- senders can publish signed messages
- senders can later emit `FORGET` for their own messages
- reads are public
- small bootstrap registrations are message objects, not the same thing as
  paid long-term IPFS pinning

What is still **not** clearly documented upstream:

- an automatic expiry time for ordinary bootstrap `POST` messages
- whether Aleph nodes garbage-collect old bootstrap `POST` messages on their
  own after some time
- whether abusive or spammy `POST` messages are automatically pruned from the
  network or merely hidden by indexers or moderation policy
- whether old forgotten bootstrap messages disappear from every query path on a
  documented schedule

So our current documented position should stay conservative:

- bootstrap senders should manage their own old records
- consumers should not assume Aleph will automatically clean the namespace for
  them
- message lifetime on the Aleph network is still partially unknown from the
  public docs alone

## Deletion And Abuse Handling

We now have partial self-cleanup support, but the operational model is still
important to document clearly.

What we currently believe:

- the sender of a bootstrap post should be able to delete it with a `FORGET`
  message
- a third party should not be able to delete another sender's bootstrap post
- if someone spammed a namespace, app-side filtering by freshness and by
  multiaddr validity would reduce some impact, but would not be enough as a
  complete moderation strategy

What is implemented today:

- deploy-time bootstrap publication can forget older self-owned bootstrap
  records when a stable `registrationId` is available
- the external `refresh-bootstrap` mode also forgets older self-owned records
  for the same `registrationId` by default
- consumer-side discovery already collapses to the newest fresh record per
  relay identity

Questions still worth answering:

- what is the exact Aleph deletion flow for a previously published bootstrap
  `POST`
- how quickly does a forgotten `POST` disappear from `posts.json`
- are there Aleph-side moderation or anti-spam limits we should rely on
- should we add optional allowlists by wallet address, relay profile, or DNS
  suffix for stricter consumer-side filtering

### Practical Spam Risk

At the moment, the bootstrap namespace should be treated as publicly writable
by any wallet that can submit valid Aleph messages.

That means a spam relay or unrelated sender could likely publish extra
bootstrap-shaped records into the same `channel` and `ref`.

Because we do not currently have source-backed proof that Aleph automatically
deletes or rejects those records later, our design should assume:

- spam is possible
- arbitrary valid keys appear able to publish bootstrap `POST` records in
  practice, based on our live ephemeral-key test
- third-party spam cannot be removed by our relay operator unless the spammer
  forgets its own messages
- consumer-side filtering remains necessary even if relays start forgetting
  their own old posts

For that reason, freshness alone is not enough as a final anti-spam strategy.
We likely also need at least one of:

- latest-record-per-sender collapsing
- sender allowlists
- app-specific namespaces
- relay-profile-specific namespaces

## Implementation Plan

The next implementation steps should treat the current system as a useful
prototype, not the final operational shape.

### Phase 1: Preserve The Working Baseline

- keep the current deploy-time publish flow
- keep external `refresh-bootstrap` available as the temporary heartbeat path
- keep forgetting older self-owned bootstrap records whenever a stable
  `registrationId` is available
- keep multi-page discovery and newest-per-relay selection in place

Goal:

- maintain a working bootstrap registry while we add stronger trust semantics

### Phase 2: Introduce Dual-Key Bootstrap Proofs

- generate or inject relay key `B` for the VM
- define an owner-signed authorization payload from key `A` to key `B`
- define a relay-signed bootstrap payload from key `B`
- extend the bootstrap record schema to carry both proof layers
- keep `peerId`, `multiaddrs`, `browserMultiaddrs`, and `updatedAt` inside the
  relay-signed payload

Goal:

- make it possible for readers to verify that the relay itself signed the
  bootstrap record and that this relay key was authorized by the deployment
  wallet

Status:

- implemented in the shared bootstrap schema and publish helpers

### Phase 3: Verify Dual-Key Records On Read

- add verification helpers in `@le-space/aleph-bootstrap`
- reject records whose owner authorization is invalid
- reject records whose relay signature is invalid
- reject records whose signed relay payload does not match the advertised
  `peerId` and multiaddrs
- continue treating successful dial as the real liveness check

Goal:

- move bootstrap trust from "wallet-signed payload we believe" to "relay-signed
  payload authorized by the deployment wallet"

Status:

- implemented as optional verification on read
- legacy records are still accepted by default unless
  `requireDualKeyAttestation: true` is enabled

### Phase 4: Move Heartbeats Into The Relay VM

- keep external `refresh-bootstrap` available as a fallback and repair path
- let relay key `B` refresh the bootstrap record from inside the VM
- for both relay profiles, preseed the relay libp2p secp256k1 identity from
  publisher key `B` before first start when that key is supplied
- for `orbitdb-relay`, continue supporting the older owner-authorization
  writeback flow when publisher key `B` is not supplied
- store only the owner authorization record plus publisher key `B` in the
  guest
- run periodic guest-side systemd timers for both relay profiles

Goal:

- make long-lived relays autonomous without storing the main deployment wallet
  key in the VM

Status:

- implemented for `uc-go-peer` and `orbitdb-relay`
- both relay profiles now pre-seed the relay libp2p identity from publisher
  key `B` when it is supplied
- `orbitdb-relay` still retains the Ed25519 fallback when `B` is not
  supplied
- remaining work is mainly operational validation on real deployments and
  deciding when consumers should require dual-key attestation by default

### Phase 5: Forget Old Self-Owned Records

- keep forgetting older self-owned bootstrap records whenever a stable relay
  identity is available
- make sure relay-side refresh continues to replace old records cleanly
- keep measuring how quickly forgotten records disappear from `posts.json`

Goal:

- reduce namespace clutter caused by our own legitimate refresh traffic

### Phase 6: Tighten Consumer Query Semantics

- keep collapsing records to the newest post per relay identity
- continue using `registrationId` first, then sender address as fallback
- keep the freshness window, but apply it to the newest relay record rather
  than blindly merging every recent post
- continue filtering out local/private multiaddrs

Goal:

- make bootstrap discovery more stable and less sensitive to duplicate refresh
  posts

### Phase 7: Reduce Spam Surface

- consider app-specific or environment-specific namespaces instead of one broad
  shared namespace
- optionally add sender allowlists for production consumers
- document what a trusted publisher set looks like for each consuming app

Goal:

- avoid treating every public writer in the namespace as equally trusted

### Phase 8: Clarify Aleph Retention Operationally

- publish a dedicated test record
- forget it from the same wallet
- poll `posts.json` and direct message queries until disappearance or stable
  persistence is observed
- repeat with time-delayed checks to learn whether ordinary unforgotten `POST`
  messages are ever pruned automatically

Goal:

- replace our current retention assumptions with measured operational facts

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
- republishes the same relay identity with refreshed public multiaddrs
- requests `FORGET` for the older record
- includes localhost/private multiaddrs in the write input on purpose
- polls Aleph until the refreshed message is readable
- verifies that discovery only returns valid public browser-dialable bootstrap
  addrs
- reports whether the forgotten older hash still remains visible in API queries

### Public Read Check Without Any Key

After a live test run, the post can be queried without a wallet:

```bash
curl -s "https://api2.aleph.im/api/v0/posts.json?channels=simple-todo&refs=YOUR_REF&types=relay-bootstrap-v2&pagination=10&page=1"
```

Use `types=relay-bootstrap` to inspect legacy full-shape records during the
v1/v2 migration window.

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
6. What exact authorization payload shape do we want from owner key `A` to
   relay key `B`?
7. Should the relay key `B` also be the relay's libp2p identity key, or should
   that remain a separate cryptographic layer?
8. What is the best way to serialize and verify relay-key signatures in
   browser-friendly consumers?

## Suggested Next Steps

- keep the current 7-day freshness filter for consumers
- keep live publishing enabled for the relay deployment flows
- keep the new newest-record-per-identity read semantics in place
- keep automatic self-`FORGET` for producers that can provide a stable
  `registrationId`
- design the exact owner-authorization payload from key `A` to relay key `B`
- design the exact relay-signed bootstrap payload from key `B`
- implement read-side verification helpers before switching the preferred
  heartbeat path to in-guest refresh
- confirm Aleph retention and moderation expectations in upstream docs or with
  the Aleph team
