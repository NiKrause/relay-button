# `@le-space/playwright`

Shared Playwright fixtures and lifecycle helpers for Relay Button consumers.

The package keeps application scenarios local while consolidating wallet
injection, accessible Relay Button controls, Aleph INSTANCE/bootstrap lookup,
browser-address selection, PubSub readiness, evidence, and verified cleanup.

```ts
import {
  createRelayTest,
  installEip1193WalletMock,
  waitForPubsubSubscriber,
  type RelayWalletAccount,
} from '@le-space/playwright'
```

`@playwright/test` is a peer dependency. Use a compatible 1.61.x client; remote
Playwright servers must use the exact same client/server version.

## Aleph remote Chromium

`connectAlephChromium()` is the thin consumer-facing adapter for the dedicated
Aleph runner. It authenticates the `/version` probe and websocket with the same
per-run bearer secret, requires HTTPS/WSS, checks the guest is exactly
Playwright `1.61.1`, and only then calls `chromium.connect()`.

```ts
const browser = await connectAlephChromium({
  chromium,
  wsEndpoint,
  versionUrl,
  secret,
})
```

`buildAlephCostEvidence()` and `formatAlephCostGithubSummary()` keep required
credit capacity separate from the authoritative before/after account balance
delta. A balance delta is attributable to one run only when that deployment
account is not being used concurrently.

`selectExpiredAlephPlaywrightRunners()` is the safety boundary used by the
retention janitor. The repository script requires an explicit repository scope
and owner key, then erases, owner-signs FORGET for, and verifies each selected
exact INSTANCE hash. It never cleans by display name alone.
