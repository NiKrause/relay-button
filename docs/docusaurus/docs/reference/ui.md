# Embed the Relay Button

`@le-space/ui` is the embeddable Relay Button widget: a floating launcher plus
a deployment panel that lets a visitor of your app connect MetaMask, pay with
Aleph credits, and deploy an internet-reachable relay VM — without your app
implementing any Aleph logic. The same component ships for **Svelte** and
**React**; both render the same UI on top of one shared controller
(`createSponsorRelayController`), so behaviour, progress reporting, and CRN
failover are identical across frameworks. The only thing your app must supply
is a rootfs manifest URL.

## Install

```bash
npm install @le-space/ui
# or: pnpm add @le-space/ui
```

Peer dependencies (declared in `packages/ui/package.json`): `svelte >= 4` for
the Svelte entrypoint, `react >= 18` and `react-dom >= 18` for the React one.
Install only the one you use — your framework is already there.

## Embed it in Svelte

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

That is the whole integration. Mount it once, near the root of your app — the
launcher positions itself (`position: fixed`, bottom right) and the panel
renders as an overlay, so it does not need a layout slot.

The Svelte entrypoint ships **uncompiled `.svelte` source**
(`scripts/prepare-publish.mjs` copies `src/svelte/` verbatim into the
published package), so your build must run it through the Svelte compiler
plugin — a plain SvelteKit or Vite + `@sveltejs/vite-plugin-svelte` setup
already does. The component imports its own theme stylesheet, so there is no
separate CSS import to wire up.

## Embed it in React

```tsx
import SponsorRelayFab from '@le-space/ui/react'

export function App() {
  return (
    <>
      <YourApp />
      <SponsorRelayFab
        manifestUrl="https://example.com/rootfs-manifest.json"
        instanceName="my-app-relay"
        showInstances
      />
    </>
  )
}
```

The React build injects its theme as an inline `<style>` element, so there is
no CSS import at all. It is a client component — render it below a
`'use client'` boundary in Next.js/RSC setups, since it touches
`window.ethereum` and `localStorage`.

To place the launcher inside your own header instead of floating it:

```tsx
<SponsorRelayFab launcherMode="inline" manifestUrl="/rootfs-manifest.json" />
```

In `inline` mode the button renders in normal flow (`position: relative`) and
the panel anchors itself under the launcher.

## Props

Every prop is optional. The full type is `SponsorRelayProps` in
`packages/ui/src/shared/types.ts`; defaults come from
`defaultState()` in `packages/ui/src/shared/controller.ts` and the constants in
`packages/ui/src/shared/constants.ts`.

| Prop | Type | Default | What it does |
| --- | --- | --- | --- |
| `manifestUrl` | `string` | `'./rootfs-manifest.json'` | URL of the rootfs manifest describing the image to deploy. Resolved relative to the host page; the panel blocks deployment if the referenced Aleph rootfs `STORE` is not `processed`. |
| `manifestJson` | `string` | `''` | Inline manifest JSON. When non-empty it wins over `manifestUrl` and the panel opens its "Paste Manifest" section pre-filled. |
| `sshPublicKey` | `string` | `''` | SSH public key baked into the instance so the operator can log into the VM. Editable in the panel's Advanced section. |
| `instanceName` | `string` | `'sponsor-relay'` | Name attached to the Aleph `INSTANCE` metadata and shown in the instance list. |
| `showInstances` | `boolean` | `true` | Show the "Instances" section listing the connected wallet's existing deployments (status, IPs, SSH command, mapped ports, delete button). |
| `openByDefault` | `boolean` | `false` | Render the panel already expanded instead of collapsed behind the launcher. |
| `launcherMode` | `'floating' \| 'inline'` | `'floating'` | `floating` pins the launcher to the bottom-right corner; `inline` renders it in normal document flow (for toolbars/headers) and anchors the panel below it. |
| `version` | `string` | `UI_PACKAGE_VERSION` | Version label shown in the panel eyebrow. Leave unset to display the installed `@le-space/ui` version; a leading `v` is added if missing. |
| `debug` | `boolean` | `false` | Verbose `console.debug('[le-space/ui]', …)` tracing of the deployment state machine. Also enabled without a prop by setting `localStorage.LE_SPACE_UI_DEBUG = '1'`. **React only** — the Svelte component does not declare this prop, so use the `localStorage` switch there. |
| `apiHost` | `string` | `'https://api2.aleph.im'` | Single Aleph Core Channel Node API host. Ignored when `apiHosts` is given. |
| `apiHosts` | `string \| readonly string[]` | `['https://api2.aleph.im', 'https://api.aleph.im']` | Ordered Aleph API hosts with automatic failover on request errors. Accepts an array or a comma/whitespace-separated string. `api3.aleph.im` is filtered out. |
| `crnListUrl` | `string` | `'https://crns-list.aleph.sh/crns.json'` | Source of the CRN (compute node) list used for compatibility filtering and scoring. When this endpoint is unreachable the client falls back to the `corechannel` aggregate read from `apiHosts`, so a crns-list outage no longer blocks deployment — see [CRN discovery](./crn-discovery.md). |
| `crnSource` | `'auto' \| 'aggregate' \| 'list'` | `'auto'` | Which CRN source to read. `auto` falls back to the `corechannel` aggregate when `crnListUrl` is down, `aggregate` skips it, `list` disables the fallback so an outage surfaces as an error. Overridable at runtime without a reload via `localStorage.LE_SPACE_CRN_SOURCE` — see [CRN discovery](./crn-discovery.md#browser-the-live-switch). |
| `schedulerApiHost` | `string` | `'https://scheduler.api.aleph.cloud'` | Aleph scheduler used to resolve the allocation for a submitted instance. |
| `twoN6ApiHost` | `string` | `'https://api.2n6.me'` | 2n6 API used to resolve the VM's HTTPS hostname, which the controller probes before declaring a relay reachable. |
| `ucanStoreBootstrap` | `Partial<SponsorRelayUcanStoreBootstrapInput>` | see below | Pre-fills the UCAN Store bootstrap form. Only used when the manifest declares `profile: "ucan-store"`. |

### `ucanStoreBootstrap` fields

These only appear when the loaded manifest sets `profile: "ucan-store"`; in
that case the panel switches to service wording and exposes a "UCAN Store
Bootstrap" section. Every field is a string (the panel is a form).

| Field | Default | What it does |
| --- | --- | --- |
| `adminDid` | `''` | DID that receives admin capabilities on the deployed store. |
| `serviceDid` | `'did:web:ucan-api.nicokrause.com'` | Override for the service DID. |
| `spaceDid` | `''` | Target space DID. |
| `rootDelegationProof` | `''` | Root delegation proof the service uses to issue user delegations. |
| `allowedCapabilities` | `space/blob/add`, `space/blob/list`, `space/index/add`, `space/index/list`, `filecoin/offer`, `upload/add`, `upload/list`, `store/add` (newline-separated) | Capabilities the service may delegate onward. One per line or comma-separated. |
| `defaultUserDelegationExpiration` | `'31536000'` (1 year, seconds) | Default lifetime of issued user delegations. |
| `maxUserDelegationExpiration` | `'315360000'` (10 years, seconds) | Upper bound the service accepts. |
| `pwaOrigin` | `'https://ucan.nicokrause.com'` | Origin allowed to talk to the service. |
| `serviceOrigin` | `'https://ucan-api.nicokrause.com'` | Public origin of the service. Left empty, guest configuration falls back to the runtime proxy URL. |

The operator address is never a prop — it always comes from the connected
MetaMask account.

## Theming

Dark ("Deep Space") is the default. Light mode activates automatically below
any ancestor carrying `data-theme="light"` (the Docusaurus convention, so a
docs site theme toggle just works) or `data-relay-theme="light"`:

```html
<div data-relay-theme="light">
  <!-- Relay Button renders in light mode here -->
</div>
```

The two builds expose different token prefixes, because the Svelte build ships
a stylesheet and the React build injects its tokens:

| Build | Token prefix | Where |
| --- | --- | --- |
| Svelte | `--relay-*` | `packages/ui/src/svelte/styles/theme.css`, also published as `@le-space/ui/styles.css` |
| React | `--rb-*` | injected inline by the component |
| Both (host overrides) | `--le-space-sponsor-relay-*` | read by the React build for panel/launcher chrome |

Override tokens from your own CSS — declare them after the widget's own rules
(e.g. on `:root` in your app stylesheet):

```css
/* Svelte build */
:root {
  --relay-accent: #7c5cff;           /* primary action colour */
  --relay-accent-contrast: #ffffff;  /* text on the primary button */
  --relay-panel-bg: rgba(16, 18, 32, 0.98);
  --relay-panel-border: #2b3350;
  --relay-font-body: "IBM Plex Sans", system-ui, sans-serif;
}

[data-theme="light"] {
  --relay-accent: #5a3ce0;
  --relay-panel-bg: #ffffff;
  --relay-panel-border: #d9e0ec;
}

/* React build — same idea, --rb-* prefix */
:root {
  --rb-accent: #7c5cff;
  --rb-accent-contrast: #ffffff;
  --rb-panel-bg: rgba(16, 18, 32, 0.98);
  --rb-border: #2b3350;
}

/* Host-page overrides honoured by the React build regardless of theme */
:root {
  --le-space-sponsor-relay-panel-bg: rgba(16, 18, 32, 0.98);
  --le-space-sponsor-relay-launcher-start: #1a1f2e;
  --le-space-sponsor-relay-launcher-end: #10131c;
}
```

The widget deliberately does **not** bundle font files. It declares
`Inter` / `JetBrains Mono` with system fallbacks, so host pages that already
load the brand fonts get the full look and everyone else gets a clean
fallback. The full palette, type scale, and rationale live in
[Branding](./branding.md).

## Entrypoints

The published package (`exports` map built by `scripts/prepare-publish.mjs`)
exposes:

| Entrypoint | Contents |
| --- | --- |
| `@le-space/ui` | Alias of `/shared`. |
| `@le-space/ui/shared` | Framework-agnostic layer: `createSponsorRelayController`, `SponsorRelayController`, the `SponsorRelayProps` / `SponsorRelayState` types, `rootfsHealth`, wallet helpers (`connectWallet`, `personalSign`, `watchWallet`, `getEthereumProvider`), formatters (`shortHash`, `formatNumber`, `formatDateTime`, `formatTierSpecLabel`, `joinMappedPorts`, `joinRequiredPortForwards`, `buildSshCommand`), `resolveManifestSource`, `createDeploymentProgressEmitter`, `UI_PACKAGE_VERSION`, and the `DEFAULT_*` constants. |
| `@le-space/ui/svelte` | `SponsorRelayFab` (default and named export), uncompiled `.svelte` source. |
| `@le-space/ui/react` | `SponsorRelayFab` (default and named export) plus the `useSponsorRelayController` hook. |
| `@le-space/ui/styles.css` | The Svelte theme tokens as a standalone stylesheet, for host pages that want the `--relay-*` palette without the component. |

### Driving the controller yourself

If you want the deployment engine but your own chrome, skip the components and
use the shared entrypoint directly. This is exactly what both components do
internally:

```ts
import { createSponsorRelayController } from '@le-space/ui/shared'

const controller = createSponsorRelayController({
  manifestUrl: 'https://example.com/rootfs-manifest.json',
})

const unsubscribe = controller.subscribe((state) => {
  render(state)  // state.wallet, state.instances, state.rootfsHealth, …
})

controller.subscribeToDeploymentProgress((event) => {
  // { stage, label, progress, status, itemHash, detail, error, timestamp }
  console.log(event.stage, event.progress)
})

await controller.init()
await controller.connectWallet()
await controller.deploy()

// on teardown
unsubscribe()
controller.destroy()
```

React consumers can get the same objects with the exported hook:

```tsx
import { useSponsorRelayController } from '@le-space/ui/react'

const { controller, state } = useSponsorRelayController({ manifestUrl })
```

## What the panel does for you

- Connects MetaMask, and keeps wallet/chain changes in sync.
- Loads and validates the rootfs manifest, and **blocks deployment** when the
  referenced Aleph rootfs `STORE` is missing or not yet `processed` — with a
  dedicated blocker card instead of a failed deploy.
- Fetches Aleph pricing, shows required vs. available credits, and lets the
  user pick a tier.
- Ranks compatible CRNs and lets the user pin one, or picks the best score
  automatically.
- Runs the deploy with **CRN failover**: up to five candidates, cleaning up
  (bootstrap config + `INSTANCE` FORGET) after each failed attempt — see
  [Deployment Lifecycle](../architecture/deployment-lifecycle.md).
- Reports live progress (stage, percentage, item hash) through the panel and
  the progress emitter.
- Lists existing deployments with status, IPs, SSH command, mapped ports,
  bootstrap-registration state, and a delete action — plus a way to forget
  orphaned bootstrap registrations.

## Where it sits in the stack

```
@le-space/shared-types → @le-space/core → @le-space/browser → @le-space/ui
```

Browser-safe Aleph API and wallet transport belongs in `@le-space/browser`;
`@le-space/ui` owns the rendered deployment UX on top of it and should not
re-own low-level transport. Keep app-specific onboarding narrative, branding,
and product-coupled flows in your own app — that split is described in
[Package Boundaries](../architecture/package-boundaries.md).
