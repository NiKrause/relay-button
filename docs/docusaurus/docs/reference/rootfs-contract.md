# Rootfs Contract Reference

The shared repo is being prepared to own the reusable rootfs contract and guest
script example used by `uc-go-peer`.

## Current State

Today the rootfs build implementation still primarily lives in
`universal-connectivity`, while the shared repo already provides:

- manifest types
- manifest validation
- rootfs Aleph `STORE` verification helpers
- rootfs reference resolution helpers

That means the contract surface is moving into shared code before the full build
pipeline does.

## Manifest Expectations

The shared manifest helpers currently expect the UC-style rootfs manifest shape
and validate key fields such as:

- version
- profile name
- rootfs item hash
- optional CID
- required port-forward declarations

This keeps the shared repo aligned with the current `uc-go-peer` publishing
flow while staying ready for future legacy-profile support later.

## Shared Rootfs Direction

The planned end state is:

- shared repo owns the rootfs manifest schema
- shared repo owns example guest scripts
- shared repo exposes reusable rootfs build helpers
- consumer repos keep only minimal profile-specific wrappers

## Recommended Next Extraction Steps

- move the reusable guest script baseline into `@shared-aleph/rootfs`
- move rootfs manifest generation into shared code
- migrate the shared reusable workflow away from placeholder status
- keep an override path for consumer-specific profile behavior
