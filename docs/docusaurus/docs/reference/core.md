# Deploy Without the Widget

`@le-space/core` holds the deployment logic itself: what a rootfs manifest
must contain, which CRNs can host a profile, how an Aleph `INSTANCE` is built
and broadcast, how a guest is configured after boot, and how relays register
themselves for discovery.

It runs in both Node and the browser. Everything above it — the
[GitHub Action](./github-action.md), the [CLI](./node-cli.md), the
[widget](./ui.md) — is a different way of driving these same functions.

Reach for it directly when you are building a fourth way.

## Install

```bash
npm install @le-space/core@next
```

Releases go out under `next` first; see the note in
[Getting Started](../getting-started.md).

`@le-space/core` takes `fetch` and a signer as arguments rather than reaching
for them. That is what lets the same function serve a CI runner holding a
private key and a browser holding a MetaMask connection.

## What each module owns

| Module | Owns |
| --- | --- |
| `manifests` | `validateRootfsManifest`, `verifyRootfsExists` — a manifest is checked before anything is signed |
| `crns` | `fetchCrnsFromList`, `filterDeployableCrns` — candidate discovery and compatibility |
| `instance-deployment` | Building the `INSTANCE` message, SSH key normalisation |
| `broadcast` | Publishing a signed message and waiting for Aleph to process it |
| `deployment-inspection` | Reading back what a deployment actually became |
| `runtime` | Waiting for the CRN to expose runtime networking and mapped ports |
| `guest` | `notifyCrnAllocation`, configuring the guest after boot |
| `bootstrap-registration` | Publishing and reading relay bootstrap records |
| `bootstrap-config`, `bootstrap-reconcile` | Guest configuration handoff, reconciling owner records |
| `port-forwarding` | The port-forward aggregate a profile requires |
| `aggregate-publication`, `retention`, `forget` | Aleph aggregate writes, keeping N deployments, FORGET |
| `crn-control` | Talking to a CRN directly |
| `aleph-normalizers` | Turning Aleph's payloads into the shapes above |
| `constants` | Channels, defaults, API hosts |

All are re-exported from the package root.

## The shape of a deployment

The functions compose in a fixed order, and knowing it makes the module list
above readable:

```
validateRootfsManifest → verifyRootfsExists   the image exists and is processed
        ↓
fetchCrnsFromList → filterDeployableCrns      who could host this
        ↓
build INSTANCE → broadcast → wait processed   Aleph accepts it
        ↓
publish port-forward aggregate                the ports the profile declared
        ↓
wait for runtime networking                   the CRN actually exposes them
        ↓
configure guest → publish bootstrap record    the relay is usable and findable
```

Each step can fail in a way the next cannot recover from, which is why they are
separate exports rather than one `deploy()`. A caller that wants CRN failover
loops over the middle of this pipeline; see
[Deployment Lifecycle](../architecture/deployment-lifecycle.md).

## CRN discovery has two sources

`fetchCrnsFromList` reads `crns.json`. When that service is down, the same
candidates can be read from the `corechannel` aggregate, which every Aleph API
host serves. The aggregate carries no liveness signal, so candidates from it are
probed before they cost a deployment attempt.

`crns.json` stays the default — it is the only source carrying `qemu_support`
and free capacity. The reasoning, and what would change it, is in
[CRN Discovery](./crn-discovery.md).

## Bootstrap registration

A relay publishes a signed record so browsers can find it later without
hardcoding an address. `publishRelayBootstrapRegistration` writes it;
`waitForRelayBootstrapRegistration` polls until Aleph serves it back.

The wait matters more than it looks: a record that was accepted but is not yet
visible is indistinguishable from one that failed, and a deployment whose
registration never became visible is running and paid for but undiscoverable.
The full model is in [Aleph Bootstrap](./aleph-bootstrap.md).

## Where it sits in the stack

```
@le-space/shared-types → @le-space/core → @le-space/browser → @le-space/ui
                                       ↘ @le-space/node
```

`@le-space/core` is environment-agnostic on purpose. Browser-only concerns
(injected wallets) live in [`@le-space/browser`](./browser.md); Node-only ones
(keys on disk, Actions plumbing) in [`@le-space/node`](./node-cli.md). If a
change to core needs `window` or `fs`, it belongs one layer out — that rule is
what keeps the same deployment behaving identically from CI and from a browser.

See [Package Boundaries](../architecture/package-boundaries.md).
