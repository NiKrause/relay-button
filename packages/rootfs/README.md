# @le-space/rootfs

Shared rootfs contract parsing, reference profile assets, and build helpers.

## Current scope

- typed parsing and validation of rootfs contract JSON
- shell-env mapping compatible with the existing UC rootfs builder
- copied `uc-go-peer` reference contract and guest asset set
- copied `orbitdb-relay` reference contract and guest asset set,
  including the delayed first-start, setup endpoint, Caddy, and AutoTLS flow
- added a `ucan-store` reference contract scaffold with documented service
  ports and consumer env expectations

## Reference assets

Current shared reference profiles live under:

- `reference/uc-go-peer/contract.json`
- `reference/uc-go-peer/rootfs/*`
- `reference/orbitdb-relay/contract.json`
- `reference/orbitdb-relay/rootfs/*`
- `reference/ucan-store/contract.json`
- `reference/ucan-store/rootfs/*`
