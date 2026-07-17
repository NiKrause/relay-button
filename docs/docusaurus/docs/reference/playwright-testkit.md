---
title: Playwright Relay Button test kit
---

# Playwright Relay Button test kit

`@le-space/playwright` contains the framework-independent parts of a Relay
Button end-to-end test. React and Svelte consumers keep their application
scenario—chat or TODO replication—while sharing wallet injection, accessible
Relay Button controls, provisioning, bootstrap discovery, address selection,
evidence, and verified teardown.

## Installation and compatibility

```bash
npm install --save-dev @le-space/playwright@next @playwright/test@1.61.1
```

`@playwright/test` is a peer dependency. The current package supports Playwright
1.61.x. When a test connects to a remote Playwright server, pin client and
server to the exact same version; compatible test-runner APIs alone do not
guarantee a compatible websocket protocol.

## Minimal consumer setup

```ts
import { privateKeyToAccount } from 'viem/accounts'
import {
  createRelayEvidence,
  createRelayTest,
  installEip1193WalletMock,
} from '@le-space/playwright'

const account = privateKeyToAccount(process.env.RELAY_E2E_PRIVATE_KEY as `0x${string}`)
const evidence = createRelayEvidence({
  instanceName: `relay-e2e-${Date.now()}`,
  ownerAddress: account.address,
  steps: {
    provision: 'Relay provisioned',
    scenario: 'Consumer scenario passed',
    cleanup: 'Relay forgotten and deallocated',
  },
})
const test = createRelayTest({ account, evidence })

test('consumer scenario', async ({ browser, relayLifecycle }) => {
  const context = await browser.newContext()
  await installEip1193WalletMock(context, account)
  const page = await context.newPage()
  await page.goto(process.env.APP_URL!)

  const relay = await relayLifecycle.provision(page, {
    instanceName: evidence.instanceName,
    sshPublicKey: process.env.RELAY_E2E_SSH_PUBLIC_KEY!,
  })

  // Keep app-specific chat or TODO assertions in the consumer.
  console.log(relay.peerId, relay.addresses)
})
```

The fixture records every resolved INSTANCE and runs awaited cleanup after the
test body on success or failure. If provisioning fails after VM submission, it
attempts to resolve the INSTANCE by owner, unique name, and start time before
teardown.

## API reference

### Wallet and UI

- `installEip1193WalletMock(context, account)` installs the minimal EIP-1193
  provider used by the Relay Button and signs `personal_sign` requests with the
  supplied account.
- `RelayButtonDriver` locates the launcher, form fields, deploy control, refresh
  control, and INSTANCE delete control using accessible roles and labels.
- `waitForDeployableManifest(page, options)` resolves when deployment is
  enabled and fails immediately for terminal RootFS states.

### Provisioning and bootstrap

- `provisionRelay(page, options)` prepares the Relay Button, deploys, resolves
  the complete Aleph INSTANCE hash, waits for the matching bootstrap record,
  and returns authenticated browser-dialable addresses.
- `waitForBootstrapRegistration(options)` tolerates delayed Aleph visibility
  and replica failures.
- `selectBrowserRelayAddresses(content, policy)` accepts secure WebSocket,
  WebTransport, and WebRTC Direct addresses. WebTransport and WebRTC Direct
  require a certificate hash by default.

### Cleanup

- `cleanupRelay(options)` requests UI deletion first. If Aleph replicas and the
  scheduler do not confirm removal within the grace period, it executes an
  awaited owner-signed CRN erase and FORGET fallback.
- `waitForAlephInstanceDeletion(options)` succeeds only after both stable Aleph
  replicas report forgotten state and the scheduler reports deallocation.
- `createRelayTest(options)` provides the auto-cleanup lifecycle fixture.

### Evidence

- `createRelayEvidence`, `updateRelayEvidenceStep`, and `writeRelayEvidence`
  maintain the portable JSON result.
- `formatRelayGithubSummary` and `appendRelayGithubSummary` render the same
  result as a GitHub Actions job summary.

Upload the JSON result, Playwright screenshots/report, trace, and video from an
`if: always()` artifact step.

## Aleph API replica policy

The only supported replicas are queried in this order:

1. `https://api2.aleph.im`
2. `https://api.aleph.im`

`resolveAlephApiHosts` rejects unsupported hosts and explicitly filters
`api3.aleph.im`, including caller-provided configuration. If every supplied
host is unsupported, the safe default pair is restored.

## Framework boundary

The shared driver intentionally knows nothing about React, Svelte, Next.js, or
SvelteKit. It uses the Relay Button's accessible contract. Consumers retain:

- Universal Connectivity: `ChatBrowserAgent`, libp2p dialing, and bidirectional
  chat assertions.
- Simple Todo: `TodoBrowserAgent`, mnemonic/database setup, OrbitDB dialing,
  and bidirectional TODO replication assertions.

Do not move consumer page selectors or scenario state into this package.

## Troubleshooting

- **Manifest rejection:** inspect the terminal state in the thrown error,
  republish the RootFS, and update the manifest before retrying.
- **Bootstrap timeout:** use a unique INSTANCE name, confirm owner address and
  timestamps, and retain the JSON evidence. The helper already retries api2
  before api.
- **No browser addresses:** WebTransport and WebRTC Direct entries without
  `/certhash/` are deliberately rejected. Ensure the relay publishes complete
  addresses.
- **Replica disagreement:** teardown waits for both replicas. Preserve the
  INSTANCE hash and rerun cleanup rather than treating DOM disappearance as
  proof.
- **Scheduler still allocated:** the FORGET may be visible before the CRN stops
  the VM. The cleanup verifier continues polling until both conditions hold.
- **Orphan recovery:** pass the exact INSTANCE hash to `cleanupRelay`; never
  delete by display name alone.
