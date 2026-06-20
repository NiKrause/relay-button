# Aleph Bootstrap

`@le-space/aleph-bootstrap` is the shared package for relay bootstrap
registration and discovery on Aleph.

It covers two sides of the flow:

1. relay deployment paths publish fresh public multiaddrs as Aleph `POST`
   messages
2. browser or Node libp2p apps query those posts before creating their
   bootstrap peer discovery service

## Shared Defaults

`@le-space/aleph-bootstrap` is a shared package, not a `simple-todo`-specific
integration.

Today it is used by:

- `simple-todo`
- `universal-connectivity/js-peer`
- shared relay deployment flows such as `uc-go-peer` and
  `orbitdb-relay`

The package still ships with a backward-compatible default namespace rooted in
the earliest `simple-todo` integration:

- channel: `simple-todo`
- ref: `simple-todo-bootstrap`
- compact post type: `relay-bootstrap-v2`
- legacy post type: `relay-bootstrap`

These defaults are exported for compatibility, but every value can be
overridden when a consumer needs an app-specific namespace or stronger
isolation between environments.

## Relay Registration

The shared deploy flows now register bootstrap addresses automatically for the
`uc-go-peer` and `orbitdb-relay` RootFS profiles when they are launched
through:

- the shared GitHub Action VM deploy path
- the Sponsor Relay browser UI path

New registrations prefer the compact `relay-bootstrap-v2` shape. It stores the
browser-ready bootstrap list directly in `multiaddrs`, caps it to the best
public browser-dialable candidates, and omits the old duplicate
`browserMultiaddrs` array. Legacy `relay-bootstrap` records are still supported
and keep the full diagnostic shape.

The legacy registration payload stores:

- `peerId`
- `multiaddrs`
- `browserMultiaddrs`
- `registrationId` when a producer can provide a stable relay identity
- `profile`
- `version`
- `updatedAt`

Only public multiaddrs are published. Loopback, RFC1918, link-local, and
localhost-style addresses are filtered out before the Aleph `POST` is signed.
For compact v2 records, browser transports are preferred in this order:
`/tcp/443/tls/ws`, other `/tls/ws`, WebTransport, WebRTC direct, then other
websocket addresses.

### Sponsor Relay Registration Lifecycle

For `uc-go-peer`, the browser Sponsor Relay flow is now a staged handoff rather
than a single direct bootstrap publish:

1. the browser waits for Aleph runtime networking and mapped ports
2. if Aleph reserved a `2n6` hostname, the browser waits for that HTTPS route
   to become active before handing `proxyUrl` to the guest
3. the browser publishes a short-lived `vm-bootstrap-config` aggregate keyed by
   the deployment token
4. the guest consumes that aggregate and emits a
   `vm-bootstrap-config-status` signal
5. the browser prefers relay metadata from that guest signal when it already
   contains `peerId` and public multiaddrs
6. otherwise the browser polls relay metadata, preferring the secure
   `https://relay-name.2n6.me/bootstrap/metadata` endpoint when available
7. the browser waits for the guest to publish its own `relay-bootstrap-v2`
   `POST`
   on Aleph
8. if that guest registration is delayed, the browser publishes a fallback
   bootstrap record from the owner wallet using the same `registrationId`
9. after success, the temporary bootstrap-config aggregate is removed

This matters because the relay bootstrap record is now tied to the actual
runtime addresses seen after deployment, not just to the deployment wallet or
to build-time assumptions.

### Browser Path And Workflow Path

The browser UI path and the GitHub workflow path now converge on the same final
bootstrap registration shape, but they still differ in how they hand off guest
configuration:

- browser `uc-go-peer`
  - publishes runtime networking into Aleph via `vm-bootstrap-config`
  - waits for the guest `vm-bootstrap-config-status` signal
  - can continue without HTTPS if the `2n6` route never activates
- Node/workflow deploy path
  - configures the guest directly through the temporary setup endpoint on the
    mapped host port
  - polls guest `/metadata` until public relay multiaddrs are ready
  - publishes the final bootstrap registration from the deploy runner

Both paths ultimately use the same shared registration primitives:

- `createRelayBootstrapRegistrationId(...)`
- `publishRelayBootstrapRegistration(...)`
- `waitForRelayBootstrapRegistration(...)`

### Runtime Suitability Checks

Proxy-backed HTTPS activation is only usable when the runtime exposes a public
guest IPv6. If a CRN reports a private or otherwise non-globally-routable guest
IPv6, the deploy code now treats that runtime as unsuitable for proxy-backed
HTTPS:

- the browser UI marks the runtime as unusable, cleans up the failed attempt,
  and retries another CRN when possible
- the workflow path does the same cleanup-and-retry behavior before treating
  that attempt as successful

This is not just a browser fetch quirk. It is a runtime suitability problem for
the proxy-backed HTTPS path itself.

### Current Signing Model

Today the codebase supports two bootstrap signing shapes:

- legacy wallet-signed records
- dual-key records with owner authorization plus relay proof

Current profile behavior:

- `uc-go-peer`
  - when `ALEPH_VM_BOOTSTRAP_PUBLISHER_PRIVATE_KEY` is supplied, the deploy
    flow derives a libp2p secp256k1 identity from that same publisher key `B`
  - that protobuf-encoded libp2p key is written into the guest before first
    start, so the relay `peerId` comes from the same underlying key material
    as the Aleph publisher identity
  - if owner key `A` is also supplied, the owner authorization can be minted
    up front and stored in the first guest configure call
- `orbitdb-relay`
  - now also accepts a preseeded libp2p secp256k1 identity derived from
    publisher key `B`
  - when publisher key `B` is supplied, the relay `peerId` comes from the
    same underlying key material as the Aleph publisher identity
  - when publisher key `B` is not supplied, it falls back to the older
    self-generated Ed25519 relay identity
  - in that fallback mode, owner authorization is still written back into the
    guest with a second `no_start` configure call after runtime metadata is
    known

So the remaining trust gap is now narrower than before:

- `uc-go-peer` can already bind publisher key `B` and relay `peerId` to the
  same secp256k1 root
- `orbitdb-relay` can now do the same when publisher key `B` is
  supplied
- legacy wallet-signed records are still accepted by default for backward
  compatibility

### Target Signing Model

The intended next model is a **dual-key relay bootstrap record**.

Roles:

- owner key `A`: the deployment wallet that creates or sponsors the Aleph VM
- relay key `B`: a separate key held by the running relay VM

Target proof chain:

1. owner key `A` signs an authorization statement for relay key `B`
2. relay key `B` signs the current bootstrap record payload
3. the bootstrap `POST` is published by relay key `B`
4. readers verify both signatures before trusting the record

This gives the relay enough autonomy to refresh its own bootstrap record while
still preserving a cryptographic relationship to the original deployment
wallet.

Important design note:

- this is intentionally a **dual-key** model
- it replaces earlier ideas about reusing the deployer wallet directly or
  relying on Aleph-specific publish-on-behalf delegation as the primary long
  term design
- if the relay peer identity is later made compatible with the same signing
  key material, that can simplify verification further, but the baseline plan
  is still dual-key authorization plus relay-side signing

### Current Transport Reality

Today, `relay-button` submits those signed Aleph `POST` messages
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
- loads compact `relay-bootstrap-v2` posts first, then falls back to legacy
  `relay-bootstrap` posts when v2 has no usable addresses
- skips entries older than 7 days
- keeps only the newest fresh record per relay identity
- sorts fetched records by recency client-side, even though Aleph currently
  returns page 1 newest-first for this query
- deduplicates the returned multiaddrs
- prefers `browserMultiaddrs` for legacy records when available
- verifies dual-key records when they are present

Important caveat:

- the 7-day cutoff is our application-level freshness rule
- we still do not have source-backed proof from Aleph's public docs about when
  ordinary bootstrap `POST` messages are automatically pruned, if ever
- relays should eventually republish and forget their own old bootstrap records
  instead of assuming network-side cleanup

Current implementation detail:

- when a bootstrap record includes `registrationId`, discovery collapses to the
  newest fresh record for that relay identity
- otherwise discovery falls back to the newest fresh record per sender address
- invalid dual-key records are ignored during discovery
- legacy wallet-signed records are still accepted by default

Current UI state handling also relies on `registrationId`:

- the Sponsor Relay panel marks registrations that match a live instance as
  confirmed instance-linked registrations
- registrations for the current wallet that no longer match any instance are
  shown as orphan bootstrap registrations
- deleting an instance now forgets the instance and its linked bootstrap
  registration records together
- orphan registrations can be forgotten independently from the panel

Discovery can be tightened further with:

- `verifyDualKeyAttestation: true`
  This is the default behavior for posts that already carry dual-key proof
  objects.
- `requireDualKeyAttestation: true`
  This rejects legacy wallet-signed records and only accepts dual-key-attested
  relay registrations.

Example:

```ts
import { discoverAlephBootstrapMultiaddrs } from '@le-space/aleph-bootstrap'

const list = await discoverAlephBootstrapMultiaddrs({
  requireDualKeyAttestation: true,
})
```

### Dual-Key Helpers

The package now also exposes low-level helpers for dual-key record creation and
verification:

- `signRelayBootstrapAuthorization(...)`
- `signRelayBootstrapProof(...)`
- `verifyRelayBootstrapAuthorization(...)`
- `verifyRelayBootstrapProof(...)`
- `verifyRelayBootstrapDualKeyContent(...)`
- `relayBootstrapTrustMode(...)`

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

- publishes dummy public multiaddrs into Aleph as a `relay-bootstrap-v2` `POST`
- republishes the same relay identity with refreshed public multiaddrs
- requests `FORGET` for the older bootstrap record
- polls `posts.json` until the refreshed post is visible
- re-runs discovery through `discoverAlephBootstrapMultiaddrs()`
- verifies that private and localhost multiaddrs were filtered out
- verifies that discovery selects the refreshed browser bootstrap addrs instead
  of the older ones

An optional variant also uses a fresh random ephemeral wallet key:

```bash
ALEPH_BOOTSTRAP_TEST_USE_EPHEMERAL_KEY=true pnpm test:aleph-bootstrap:live
```

In our live testing, that ephemeral-key mode was also accepted by Aleph for the
same bootstrap `POST` and `FORGET` lifecycle. For this bootstrap flow, that is
strong evidence that public write access is effectively open to arbitrary valid
keys, which reinforces the need for consumer-side anti-spam handling.

## Periodic Refresh

Two refresh paths now exist:

- external `@le-space/node` `refresh-bootstrap` mode
- in-guest periodic refresh from the relay VM itself

`@le-space/node` now supports:

```bash
ALEPH_VM_MODE=refresh-bootstrap
```

Expected environment inputs:

- `ALEPH_VM_PRIVATE_KEY`
- `ALEPH_VM_NAME`
- `ALEPH_VM_PROFILE`
- `ALEPH_VM_RELAY_PEER_ID`
- `ALEPH_VM_PROBE_MULTIADDRS_JSON`
- `ALEPH_VM_BROWSER_BOOTSTRAP_MULTIADDRS_JSON`
- optional `ALEPH_VM_ROOTFS_VERSION`
- optional `ALEPH_VM_BOOTSTRAP_REGISTRATION_ID`
- optional `ALEPH_VM_BOOTSTRAP_FORGET_PREVIOUS`
- optional `ALEPH_VM_PUBLISHER_PRIVATE_KEY`
- optional `ALEPH_VM_OWNER_PRIVATE_KEY`

That mode republishes the relay bootstrap registration and, by default,
forgets older self-owned records for the same registration ID.

Current dual-key behavior in external `refresh-bootstrap`:

- if only `ALEPH_VM_PRIVATE_KEY` is set, refresh behaves like the legacy
  wallet-signed model
- if `ALEPH_VM_PUBLISHER_PRIVATE_KEY` is set, the relay bootstrap `POST` is
  published by that publisher identity
- if `ALEPH_VM_OWNER_PRIVATE_KEY` is also set, the refresh path embeds the
  owner authorization plus relay proof objects automatically

This external mode remains useful for one-off repair or manual refresh, but it
is no longer the only heartbeat path.

Current in-guest refresh behavior:

- deploy/configure stores `ALEPH_BOOTSTRAP_PUBLISHER_PRIVATE_KEY`,
  `ALEPH_BOOTSTRAP_REGISTRATION_ID`, and a base64-encoded
  `ALEPH_BOOTSTRAP_OWNER_AUTHORIZATION_B64` record in the relay VM env file
- both relay profiles can additionally store a precomputed libp2p secp256k1
  identity derived from publisher key `B`, so the runtime `peerId` is known
  before the relay first starts
- if `orbitdb-relay` is deployed without publisher key `B`, it still
  generates owner authorization after the real relay `peerId` is known and
  writes it back into the guest with a second `no_start` configure call
- the guest runs a systemd timer:
  - `uc-go-peer-bootstrap-refresh.timer`
  - `orbitdb-relay-bootstrap-refresh.timer`
- the timer invokes a local Python refresher that:
  - calls the profile-specific `*-describe.py` helper
  - signs the relay proof with publisher key `B`
  - republishes the bootstrap `POST`
  - forgets older self-owned records for the same registration ID

This keeps the owner key `A` out of the long-lived guest state once the
authorization record has been minted.

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

## Next Implementation Focus

The main unfinished work for this feature is no longer basic publish/discover
mechanics. It is completing the stronger same-root signing path across all
relay profiles:

- the wallet that deployed the relay VM
- the key that refreshes the bootstrap record from the relay
- the `peerId` that other relays and clients actually dial

The planned implementation direction is:

1. keep the current dual-key authorization payload from owner key `A` to relay
   key `B`
2. keep the relay-signed bootstrap payload that key `B` refreshes
3. validate the new same-root `peerId <- B` model on real deployments for both
   relay profiles
4. teach consumers to require dual-key verification by default once the relay
   producers all emit it
5. keep actual liveness checks at dial time rather than trying to prove
   liveness from Aleph alone

## Consumer Notes

`universal-connectivity/js-peer` and `simple-todo` should use this package in
place of hardcoded bootstrap multiaddrs or direct `@libp2p/bootstrap` static
lists.
