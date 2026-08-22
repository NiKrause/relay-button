# @le-space/aleph-bootstrap

`@le-space/aleph-bootstrap` is the shared package for publishing and
discovering relay bootstrap multiaddrs through Aleph POST messages.

It is designed for two complementary jobs:

- relay operators publish their current public multiaddrs to Aleph
- apps load fresh bootstrap multiaddrs before creating a libp2p node

## Public API

- `discoverAlephBootstrapMultiaddrs(options)`
- `createLibp2pAlephBootstrap(options)`
- `filterRelayBootstrapPostsByProfile(posts, profile?)`
- `filterRelayBootstrapPostsByRegistration(posts, registrationId?)`
- `filterPublicMultiaddrs(addrs, options?)`
- `createRelayBootstrapPost(options)`
- `signRelayBootstrapAuthorization(args)`
- `signRelayBootstrapProof(args)`
- `verifyRelayBootstrapAuthorization(record)`
- `verifyRelayBootstrapProof(record, options?)`
- `verifyRelayBootstrapDualKeyContent(content, options?)`
- `relayBootstrapTrustMode(content)`

## Default Aleph convention

The package defaults to the shared relay-bootstrap namespace:

- channel: `simple-todo`
- ref: `simple-todo-bootstrap`
- post type: `relay-bootstrap-v2`

The channel and ref are overrideable per app or environment. The post type is
fixed to `relay-bootstrap-v2`.

## Discovery Trust Modes

The package accepts two signing modes for v2 records:

- wallet-signed bootstrap posts
- dual-key-attested bootstrap posts

By default, discovery will:

- accept wallet-signed v2 posts
- verify dual-key records when they are present
- ignore malformed or invalid dual-key records

## Scoping discovery

The channel is shared. Several relay implementations register in it, and so
does every throwaway relay an E2E run starts — under the same profile as the
production one, with a registration that outlives the machine it describes,
because guests self-publish with generated keys and no remaining key can
FORGET the post.

Two scopes, and most consumers want both:

```ts
const list = await discoverAlephBootstrapMultiaddrs({
  profile: 'orbitdb-relay',                          // not uc-go-peer's relays
  registrationId: 'relay:orbitdb-relay:orbitdb-relay' // and not the E2E ones
})
```

`profile` keeps out relays a consumer cannot use at all — an orbitdb app that
dials a `uc-go-peer` relay never gets a shared circuit and sits at
`candidates: 0`. `registrationId` keeps out its own corpses: measured
downstream, a browser probe wave against an unscoped list spent its outbound
stream budget on dead addresses and wrote off the one healthy relay along with
them.

Use `registrationId` for anything that bakes addresses into a build or dials
them on start. Omit both to see the whole channel, which is what a dashboard
wants.

If a consumer wants to require the stronger model:

```ts
const list = await discoverAlephBootstrapMultiaddrs({
  requireDualKeyAttestation: true,
})
```

## Dual-Key Model

The intended stronger trust model is:

- owner key `A` authorizes relay publisher key `B`
- relay publisher key `B` signs the bootstrap payload
- the Aleph bootstrap `POST` is published by `B`
- readers verify both the owner authorization and relay proof before trusting
  the record
