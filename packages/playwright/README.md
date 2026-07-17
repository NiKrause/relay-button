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
