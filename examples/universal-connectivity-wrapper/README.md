# universal-connectivity Wrapper Example

This example directory is reserved for the thin-wrapper pattern used by
`universal-connectivity`.

The intended shape is:

- UC keeps its upstream-friendly workflow entrypoints
- the entrypoints call the shared GitHub Action and shared reusable workflow
- UC-specific profile wiring stays small and easy to diff against upstream

Useful future example material for this folder:

- wrapper workflow calling the shared reusable workflow
- compatibility wrapper action preserving existing UC output names
- profile-specific rootfs contract handoff into shared tooling
