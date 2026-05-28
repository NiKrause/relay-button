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

## Default Aleph convention

The package defaults to the shared relay-bootstrap namespace:

- channel: `simple-todo`
- ref: `simple-todo-bootstrap`
- post type: `relay-bootstrap`

All values are overrideable per app or environment.
