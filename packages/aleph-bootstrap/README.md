# @le-space/aleph-bootstrap

`@le-space/aleph-bootstrap` is the shared package for publishing and
discovering relay bootstrap multiaddrs through Aleph POST messages.

It is designed for two complementary jobs:

- relay operators publish their current public multiaddrs to Aleph
- apps load fresh bootstrap multiaddrs before creating a libp2p node

## Public API

- `discoverAlephBootstrapMultiaddrs(options)`
- `createLibp2pAlephBootstrap(options)`
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
