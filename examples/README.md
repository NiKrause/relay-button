# Examples

The `examples/` directory is for thin reference skeletons and integration
shapes, not for copying full production applications into `relay-button`.

Use these examples to show:

- how a consumer repository calls the shared GitHub Action or workflow
- how a browser/PWA consumer imports the shared browser packages
- how a thin wrapper repo keeps its own entrypoints while delegating the Aleph
  implementation to shared tooling

Use the real project repositories for full integration references.

## Real Integrations

These are the canonical live integrations that demonstrate the shared tooling
in real use:

- `universal-connectivity`
  - runtime/connectivity changes: PR `#343`
  - Aleph workflow integration: PR `#344`
- `aleph-libp2p-relay`
  - browser/PWA integration through `relay-deployer-pwa`

Other relay projects such as `orbitdb-relay`, `qauld`, or Bitsocial
should be linked here once they adopt the same shared-tooling pattern.

## Reference Example Types

- `github-action-consumer`
  - minimal external repository consuming the shared action/workflow contract
- `node-deploy`
  - headless Node consumer using `@le-space/node`
- `relay-deployer-pwa-consumer`
  - browser/PWA consumer pattern using `@le-space/browser`
- `universal-connectivity-wrapper`
  - thin repo-local integration shape that keeps consumer-specific entrypoints
    while delegating implementation to shared tooling
