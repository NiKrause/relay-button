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
- Relay Button browser UI path in
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

## Trust Model

Current implementation:

- all bootstrap records use the `relay-bootstrap-v2` post type
- wallet-signed v2 bootstrap `POST`s remain supported
- dual-key bootstrap `POST`s are supported and readers can verify them
- both `uc-go-peer` and `orbitdb-relay` can now preseed their libp2p
  secp256k1 identity from publisher key `B`, so the relay `peerId` and Aleph
  publisher identity share the same cryptographic root when that key is
  supplied
- `orbitdb-relay` still keeps its older Ed25519-generated fallback when
  no publisher key `B` is supplied

Both signature modes are supported today, and readers can verify the dual-key
form. What is not yet in force is *requiring* it: owner key `A` authorizes
relay key `B`, `B` signs the payload it republishes, and a reader could
verify both — but demanding that would reject legacy wallet-signed records that
remain valid. Flipping the default is
[#108](https://github.com/NiKrause/relay-button/issues/108).

Superseded during design: "single key for everything", "derived child key
recognized by Aleph", and "Aleph publish-on-behalf as the primary trust model".


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

## Why Publication Still Goes Over REST

Aleph documents two submission paths: a Core Channel Node gateway, and
broadcast on the Aleph peer-to-peer network. First-party code exposes a Rust
`p2p-service` with gossipsub publish/subscribe, HTTP `identify`/`dial`
endpoints, and RabbitMQ bridging.

What does not exist, as far as we could establish: a browser-ready TypeScript
SDK for direct P2P publication, a replacement for indexed history queries such
as `posts.json`, or evidence that raw pubsub yields the same durable indexed
behaviour the REST path gives us today.

So publication and discovery stay on REST/CCN. Moving them is tracked in
[#5](https://github.com/NiKrause/relay-button/issues/5).


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
- the `uc-go-peer` and `orbitdb-relay` reference images keep their guest
  publisher key locally and run a systemd `ExecStop` hook before the relay and
  network are stopped; that hook forgets every current bootstrap record owned
  by that publisher
- Relay Button owner cleanup only includes bootstrap records published by the
  connected owner wallet; guest-published records remain the guest's
  responsibility
- the Playwright lifecycle fixture can verify the exact guest registration
  hash on both supported Aleph API replicas after VM cleanup
- consumer-side discovery already collapses to the newest fresh record per
  relay identity
- consumer-side discovery treats registrations older than 24 hours as stale;
  both relay reference images refresh immediately after configuration and then
  every six hours with up to 15 minutes of randomized delay

Guest shutdown cleanup is deliberately best effort. A CRN crash or forced
power-off can bypass `ExecStop`. Callers that know the registration hash should
therefore pass it as `registrationHash` to `cleanupRelay` and treat a failed
replica verification as leaked-registration evidence, not as successful
cleanup.

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

## Where Each Decision Landed

The design below was carried out. This section records what was decided and
where it lives, so the reasoning survives without reading as pending work.

| Decision | Implemented in |
| --- | --- |
| Deploy-time publish, newest-per-relay discovery, multi-page reads | `packages/aleph-bootstrap/src/index.ts` |
| Dual-key proofs: owner key authorizes the relay key | `signRelayBootstrapAuthorization`, `packages/core/src/bootstrap-registration.ts` |
| Read-side verification of those proofs | `verifyDualKeyAttestation`, `packages/aleph-bootstrap/src/index.ts` |
| Heartbeat refresh from inside the relay VM | `uc-go-peer-bootstrap-refresh.service` and its timer |
| Forgetting older self-owned records on refresh | `registrationId`-keyed `FORGET` in the deploy path |
| Consumer query semantics: newest per identity, freshness window, no private multiaddrs | `packages/aleph-bootstrap/src/index.ts` |

One decision is implemented but not yet in force: verification is opt-in,
because requiring it would reject legacy records that are still valid. Flipping
that default is [#108](https://github.com/NiKrause/relay-button/issues/108).


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

## Still Open

Questions the implementation did not settle. The dual-key payload shape, its
browser-side verification, and whether the relay key doubles as the libp2p
identity were all answered by building it; these were not.

1. How long does an un-forgotten bootstrap `POST` actually survive on Aleph?
   The 7-day filter consumers apply is an app-side freshness rule, not a
   retention guarantee, and we have no confirmation from upstream either way.
2. What `FORGET` flow should an operator follow to remove a stale or mistaken
   registration by hand? Automatic self-forget covers our own refresh traffic,
   not human error.
3. Do consumers want anti-spam rules beyond freshness and public-multiaddr
   filtering?
4. Should the namespace be separated per app, per environment, or per relay
   profile, instead of one shared `simple-todo` namespace?

Moving publication and discovery to direct P2P libp2p flows is tracked
separately in [#5](https://github.com/NiKrause/relay-button/issues/5).
