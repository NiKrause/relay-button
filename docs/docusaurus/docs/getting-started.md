---
title: Getting started
description: Get a relay running in five minutes, either from a button in your app or from the command line.
---

# Getting started

Two paths lead to a running relay. Pick the one that matches what you are
building:

- **Path A — embed the button.** Your users press a button in your app and a
  relay is deployed from their own browser wallet. Nothing is deployed from
  your infrastructure and no key of yours is involved.
- **Path B — deploy from the CLI.** You deploy a relay yourself from a terminal
  using a funded key. Best for a relay you operate, and the fastest way to see
  the whole flow end to end.

Both paths end at the same place: an internet-reachable relay whose bootstrap
addresses are published on Aleph, where any libp2p app can discover them.

## Prerequisites

| | Path A (button) | Path B (CLI) |
| --- | --- | --- |
| Node.js 20+ | for your app's build | yes |
| pnpm 10 | optional | yes |
| Browser wallet (MetaMask or another EIP-1193 provider) | yes, for your users | no |
| EVM private key holding Aleph credits | no | yes |
| SSH public key | no | yes |
| A published RootFS manifest | yes | yes |

The **RootFS manifest** is the JSON document that says which relay image to
deploy and how much disk, memory, and port forwarding it needs. Both paths
consume one. If you do not have one yet, use an existing published manifest to
get your first relay up, then build your own later — see the
[RootFS contract reference](./reference/rootfs-contract.md).

:::note Aleph credits, not gas

Deployments are paid with Aleph credits held by the deploying account, not by
sending a transaction. In Path A that account is your user's wallet; in Path B
it is the key in `ALEPH_VM_PRIVATE_KEY`. A key with zero credits will fail at
the pricing check before anything is signed.

:::

## Path A — embed the button in your app

The shortest possible integration. Install the shared UI package:

```bash
npm install @le-space/ui
```

`@le-space/ui` declares `react >=18`, `react-dom >=18`, and `svelte >=4` as peer
dependencies. Install whichever framework you actually use; you do not need
both.

### Svelte

```svelte
<script>
  import SponsorRelayFab from '@le-space/ui/svelte'
</script>

<SponsorRelayFab
  manifestUrl="https://example.com/rootfs-manifest.json"
  instanceName="my-app-relay"
  showInstances={true}
/>
```

### React

```tsx
import SponsorRelayFab from '@le-space/ui/react'

export function App() {
  return (
    <SponsorRelayFab
      manifestUrl="https://example.com/rootfs-manifest.json"
      instanceName="my-app-relay"
      showInstances
    />
  )
}
```

That is the whole integration. The component renders a floating launcher; when
a user opens it, it connects their wallet, resolves the manifest, checks that
the RootFS is retrievable, prices the deployment, picks a CRN, and deploys.

`manifestUrl` defaults to `./rootfs-manifest.json`, so if you ship the manifest
next to your app you can omit the prop entirely. The other props you will most
likely reach for are `instanceName`, `showInstances`, `openByDefault`, and
`launcherMode` (`'floating'` or `'inline'`). The
[UI package reference](./reference/ui.md) covers the full surface.

:::danger Never put a private key in client code

The browser widget deploys through the visitor's own EIP-1193 wallet. The
signing key never leaves their browser, and your bundle must never contain one.
If you find yourself wanting to embed a key so "the app" can deploy on a user's
behalf, you want Path B behind your own backend instead.

:::

## Path B — deploy a relay from the CLI

Clone the repository and install the workspace:

```bash
git clone https://github.com/NiKrause/relay-button
cd relay-button
pnpm install
```

Then set the four required variables and deploy:

```bash
export ALEPH_VM_PRIVATE_KEY=0x...
export ALEPH_VM_NAME=my-relay
export ALEPH_VM_SSH_PUBLIC_KEY="$(cat ~/.ssh/id_ed25519.pub)"
export ALEPH_VM_ROOTFS_MANIFEST_URL='https://connect.nicokrause.com/rootfs/uc-go-peer/latest.json'

pnpm relay-button deploy
```

`deploy` requires exactly these four inputs — `ALEPH_VM_PRIVATE_KEY`,
`ALEPH_VM_NAME`, `ALEPH_VM_SSH_PUBLIC_KEY`, and either
`ALEPH_VM_ROOTFS_MANIFEST_URL` or `ALEPH_VM_ROOTFS_ITEM_HASH`. When you pass a
manifest URL, the CLI derives the RootFS item hash, disk size, manifest
version, and required port forwards from the manifest, so you do not have to
declare them by hand.

Two optional variables are worth setting on a first run:

```bash
export ALEPH_VM_PREFERRED_COUNTRY_CODE=DE
export ALEPH_VM_ENABLE_CADDY_PROXY=true
```

`ALEPH_VM_PREFERRED_COUNTRY_CODE` biases CRN selection towards a region;
`ALEPH_VM_ENABLE_CADDY_PROXY` (default `false`) configures the guest for
proxy-backed HTTPS/WSS. Guest auto-configuration and reachability verification
(`ALEPH_VM_AUTO_CONFIGURE`, `ALEPH_VM_VERIFY_REACHABILITY`) are already on by
default.

:::tip Check connectivity before you spend credits

`pnpm exec relay-button list-crns | jq` performs no deployment and costs
nothing. If it returns a ranked, geocoded CRN list, your network path to Aleph
is fine and any later failure is about your inputs or your balance.

:::

:::caution Declare ports as objects, not numbers

If you set `ALEPH_VM_REQUIRED_PORTS_JSON` manually, it must be a JSON array of
structured objects such as
`[{"port":22,"tcp":true,"udp":false,"purpose":"SSH"}]`. Raw port numbers like
`[22,80,443]` are rejected. Deriving ports from a manifest URL avoids this
entirely.

:::

## Verify it worked

### From the CLI

The deploy runner logs its progress to stdout as it goes:

```text
[deploy] profile=uc-go-peer sender=0x1234...
[deploy] channel=TEST api_host=https://api2.aleph.im
[deploy] calling guest /configure for <instance item hash>
[deploy] polling guest /metadata until ready
[deploy] reachability verification succeeded
[deploy] publishing relay bootstrap registration to Aleph
```

The **final line of stdout is a single JSON object** describing the whole
deployment. Pull the fields that matter out of it:

```bash
pnpm exec relay-button deploy | tail -n 1 | jq '{
  itemHash,
  status,
  ssh: .runtime.sshCommand,
  proxy: .runtime.proxyUrl,
  peerId: .configuration.metadata.peer_id,
  bootstrap: .configuration.metadata.browser_bootstrap_multiaddrs,
  verified: .verification.ok
}'
```

A healthy deployment gives you:

- a non-empty `itemHash` — the Aleph `INSTANCE` message for your VM
- `verification.ok` set to `true`
- a `runtime.sshCommand` you can actually run to reach the guest
- a `configuration.metadata.peer_id` — the relay's libp2p identity
- a non-empty `configuration.metadata.browser_bootstrap_multiaddrs` list

That last list is the payoff. It contains only public, browser-dialable
addresses; loopback and private-range addresses are filtered out before the
bootstrap record is signed.

### From the button

The panel shows the same information as it happens: a wallet indicator, a
RootFS health light, a live deployment stage, and — with `showInstances` — a
list of your instances and their bootstrap registrations. A registration that
matches a live instance is marked as confirmed.

### From a consuming app

The real end-to-end check is that another app can find the relay. In any libp2p
app:

```ts
import { discoverAlephBootstrapMultiaddrs } from '@le-space/aleph-bootstrap'

const list = await discoverAlephBootstrapMultiaddrs()
console.log(list)
```

Your new relay's addresses should appear in that list. Allow a short indexing
delay after deployment before a freshly published record becomes visible.

:::caution Deployments cost credits until you stop them

A relay keeps running — and keeps costing credits — until it is deleted. Delete
test instances from the button's instance list, or with the Playwright test
kit's verified teardown, rather than leaving them allocated.

:::

## Next steps

Once your first relay is up:

- **Automate it.** Deploy from CI with the shared
  [GitHub Action](./reference/github-action.md), or build and publish your own
  image with the [reusable workflow](./reference/reusable-workflow.md).
- **Ship your own image.** Define what goes inside the VM with the
  [RootFS contract](./reference/rootfs-contract.md).
- **Publish your app.** Put a static site on IPFS and attach a domain with
  [static sites and custom domains](./reference/static-sites-custom-domains.md).
- **Test it.** Adopt the
  [Playwright Relay Button test kit](./reference/playwright-testkit.md) for
  end-to-end coverage with verified cleanup.
- **Understand the flow.** Read the
  [deployment lifecycle](./architecture/deployment-lifecycle.md) and the
  [Aleph bootstrap reference](./reference/aleph-bootstrap.md).
- **Let an agent do it.** Every task above has a paste-ready prompt in
  [AI agent recipes](./guides/ai-agent-recipes.md).
