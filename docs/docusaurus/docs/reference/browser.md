# Talk to Aleph from a Browser

`@le-space/browser` is the browser-safe layer between an app and the Aleph
network: an API client, wallet transport over EIP-1193, pricing and credit
lookups, and rootfs manifest loading. It is what
[`@le-space/ui`](./ui.md) is built on.

Reach for it when you want the deployment logic without the rendered panel —
your own UI, your own flow, or a PWA that only needs to *read* Aleph state.

## Install

```bash
npm install @le-space/browser
```

Pin a version rather than a tag. `latest` and `next` move independently of each
other, so neither is reliably the newer one — see the note in
[Getting Started](../getting-started.md).

The package is browser-first: it assumes `fetch`, and the wallet functions
assume an injected EIP-1193 provider. It carries no Node built-ins, so it
bundles without polyfills.

## The client

`createAlephBrowserClient` is the entry point. It wraps host selection,
timeouts, and the Aleph endpoints the deployment flow needs.

```js
import { createAlephBrowserClient } from '@le-space/browser'

const client = createAlephBrowserClient({
  apiHosts: ['https://api2.aleph.im', 'https://api.aleph.im'],
})

const balance = await client.fetchBalance(address)
const instances = await client.fetchInstances(address)
```

Passing more than one host matters: the client falls through to the next one
when a host is unreachable, which is the difference between a transient Aleph
outage and a broken app.

## What each module owns

| Module | Owns |
| --- | --- |
| `client` | `createAlephBrowserClient`, the composed API surface |
| `aleph-api` | Endpoint paths and defaults the client is built from |
| `evm` | `ethCall`, `sendTransaction`, `personalSign` over EIP-1193 |
| `wallet` | `getEthereumProvider`, `connectWallet`, `watchWallet` |
| `prepaid` | Credit balances, budget formatting, payment chain from chain id |
| `pricing` | `fetchInstancePricing`, `parseInstancePricing` |
| `rootfs` | Manifest loading and the item-hash conventions |
| `http` | `fetchWithTimeout`, used by everything above |
| `types` | The shared shapes — `Crn`, `InstanceMessage`, `RootfsManifest`, … |

All of them are re-exported from the package root, so
`import { fetchInstancePricing } from '@le-space/browser'` works; the module
paths are listed to show where responsibility sits, not as import paths you
need to use.

## Wallet transport

`wallet` finds the injected provider, connects to it, and tells you when the
account or the chain changes. `evm` speaks to a provider once you have one.
Both stay thin: they do not remember an address, prompt for a chain switch, or
decide what a disconnection means — an app already has opinions about all
three, and a library that also has them fights the app.

```js
import { connectWallet, watchWallet, personalSign } from '@le-space/browser'

const wallet = await connectWallet()
// { connected: true, address: '0x…', chainId: '0x2105', isMetaMask: true }

const stop = watchWallet(() => {
  // the account or the chain changed; read it again
})

const signature = await personalSign(wallet.address, 'message', provider)
```

Every function takes the provider as its last argument and falls back to
`getEthereumProvider()` — `window.ethereum`, or `null` off a browser — so a
page that only ever talks to the injected wallet can leave it out, and a page
with its own provider passes it in.

The address comes back exactly as the wallet reported it. This package has no
runtime dependencies and checksumming needs one, so `connectWallet` takes the
normaliser instead:

```js
import { getAddress } from 'viem'

const wallet = await connectWallet(provider, { normaliseAddress: getAddress })
```

That is what `@le-space/ui` does, which is why `connectWallet` from the UI
package returns a checksummed address and this one does not.

State belongs to the caller. `@le-space/ui` keeps its own wallet state on top
of these functions rather than inside them.

## Reading credits before you promise anything

A deployment is paid from the account's Aleph credits, and the failure mode
when they run short is a rejection *after* signing. Check first:

```js
import { loadPrepaidBudget, fetchInstancePricing } from '@le-space/browser'

const pricing = await fetchInstancePricing({ apiHost })
const budget = await loadPrepaidBudget({ apiHost, address })
```

Aleph rejects a deployment whose account cannot cover the minimum runtime, and
reports the shortfall as `required_credits` against `account_credits`. Surfacing
that before the deploy button is the single most useful thing this module does.

## Where it sits in the stack

```
@le-space/shared-types → @le-space/core → @le-space/browser → @le-space/ui
```

`@le-space/core` holds the deployment logic that runs in **both** Node and the
browser — see [Core](./core.md). `@le-space/browser` adds what only makes sense
in a browser: an injected wallet, no filesystem, no private keys in the process.
Anything that needs a key on disk belongs in [`@le-space/node`](./node-cli.md)
instead.

The boundary is described in full in
[Package Boundaries](../architecture/package-boundaries.md).
