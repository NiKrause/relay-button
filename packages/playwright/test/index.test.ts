import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildAlephCostEvidence,
  cleanupRelay,
  connectAlephChromium,
  createRelayEvidence,
  formatRelayGithubSummary,
  formatAlephCostGithubSummary,
  selectExpiredAlephPlaywrightRunners,
  installEip1193WalletMock,
  resolveAlephApiHosts,
  selectBrowserRelayAddresses,
  updateRelayEvidenceStep,
  waitForAlephInstanceDeletion,
  waitForAlephMessageForgotten,
  waitForBootstrapRegistration,
  waitForDeployableManifest,
  waitForPubsubSubscriber,
  createProgressLogger,
  forwardBrowserConsole,
  LIBP2P_DIAGNOSTIC_CONSOLE_FILTER,
  RelayButtonDriver,
  type RelayWalletAccount,
} from '../src/index.ts'

test('connectAlephChromium checks exact version and forwards bearer auth', async () => {
  const connectCalls: unknown[][] = []
  const browser = {} as never
  const result = await connectAlephChromium({
    chromium: {
      connect: async (...args) => {
        connectCalls.push(args)
        return browser
      },
    },
    wsEndpoint: 'wss://runner.example',
    versionUrl: 'https://runner.example/version',
    secret: 'run-secret',
    fetch: async (_input, init) => {
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer run-secret')
      return Response.json({ playwrightVersion: '1.61.1' })
    },
  })

  assert.equal(result, browser)
  assert.deepEqual(connectCalls, [['wss://runner.example', { headers: { Authorization: 'Bearer run-secret' }, timeout: 30_000 }]])
})

test('connectAlephChromium rejects client/server version drift before websocket connect', async () => {
  let connected = false
  await assert.rejects(
    connectAlephChromium({
      chromium: {
        connect: async () => {
          connected = true
          return {} as never
        },
      },
      wsEndpoint: 'wss://runner.example',
      versionUrl: 'https://runner.example/version',
      secret: 'run-secret',
      fetch: async () => Response.json({ playwrightVersion: '1.61.0' }),
    }),
    /client 1\.61\.1, guest 1\.61\.0/,
  )
  assert.equal(connected, false)
})

test('Aleph cost evidence separates required capacity from observed consumption', () => {
  const cost = buildAlephCostEvidence({
    startedAt: '2026-07-17T14:21:20.000Z',
    finishedAt: '2026-07-17T14:26:48.000Z',
    pricing: {
      capturedAt: '2026-07-17T14:21:19.000Z',
      apiHost: 'https://api2.aleph.im',
      unitCredit: 14_250,
      computeUnits: 2,
      vcpus: 2,
      memoryMiB: 4_096,
      diskMiB: 40_960,
    },
    before: {
      capturedAt: '2026-07-17T14:21:19.000Z',
      apiHost: 'https://api2.aleph.im',
      creditBalance: 5_000_000,
      lockedAmount: 0,
    },
    after: {
      capturedAt: '2026-07-17T14:26:49.000Z',
      apiHost: 'https://api2.aleph.im',
      creditBalance: 5_000_000,
      lockedAmount: 0,
    },
  })

  assert.equal(cost.runtimeSeconds, 328)
  assert.equal(cost.requiredCredits, 28_500)
  assert.equal(cost.creditsConsumed, 0)
  assert.equal(cost.netAccountCreditDelta, 0)
  assert.match(formatAlephCostGithubSummary(cost), /Required credit capacity \| 28500 credits/)
  assert.match(formatAlephCostGithubSummary(cost), /not a time-pro-rated charge/)
})

test('Aleph runner janitor only selects expired exact-hash instances in owner and repository scope', () => {
  const ownerAddress = `0x${'ab'.repeat(20)}`
  const base = {
    ownerAddress,
    status: 'processed',
    createdAt: '2026-07-17T10:00:00.000Z',
  }
  const result = selectExpiredAlephPlaywrightRunners({
    ownerAddress,
    repository: 'NiKrause/simple-todo',
    now: Date.parse('2026-07-17T12:00:00.000Z'),
    ttlMs: 60 * 60_000,
    candidates: [
      { ...base, itemHash: 'a'.repeat(64), instanceName: 'playwright-nikrause-simple-todo-123-1' },
      { ...base, itemHash: 'b'.repeat(64), instanceName: 'playwright-nikrause-universal-connectivity-123-1' },
      { ...base, itemHash: 'c'.repeat(64), instanceName: 'playwright-nikrause-simple-todo-124-1', createdAt: '2026-07-17T11:30:00.000Z' },
      { ...base, itemHash: 'not-a-hash', instanceName: 'playwright-nikrause-simple-todo-125-1' },
    ],
  })
  assert.deepEqual(result.expired.map(({ itemHash }) => itemHash), ['a'.repeat(64)])
  assert.deepEqual(result.retained.map(({ reason }) => reason), [
    'name outside repository scope',
    'within TTL',
    'invalid exact INSTANCE hash',
  ])
})

test('Aleph runner janitor sweeps additional exact name prefixes', () => {
  const ownerAddress = `0x${'ab'.repeat(20)}`
  const base = {
    ownerAddress,
    status: 'processed',
    createdAt: '2026-07-17T10:00:00.000Z',
  }
  const result = selectExpiredAlephPlaywrightRunners({
    ownerAddress,
    repository: 'NiKrause/simple-todo',
    now: Date.parse('2026-07-17T12:00:00.000Z'),
    ttlMs: 60 * 60_000,
    additionalNamePrefixes: ['simple-todo-e2e-'],
    candidates: [
      // The exact leak from #88: ephemeral relay VMs named by simple-todo's own
      // scheme, which the repository prefix never matched.
      { ...base, itemHash: 'a'.repeat(64), instanceName: 'simple-todo-e2e-1785074478061' },
      { ...base, itemHash: 'b'.repeat(64), instanceName: 'playwright-nikrause-simple-todo-123-1' },
      // Still young enough to be an in-flight test run.
      { ...base, itemHash: 'c'.repeat(64), instanceName: 'simple-todo-e2e-1785074478062', createdAt: '2026-07-17T11:30:00.000Z' },
      { ...base, itemHash: 'd'.repeat(64), instanceName: 'orbitdb-relay-production' },
    ],
  })
  assert.deepEqual(result.expired.map(({ itemHash }) => itemHash), ['a'.repeat(64), 'b'.repeat(64)])
  assert.deepEqual(result.retained.map(({ reason }) => reason), ['within TTL', 'name outside repository scope'])
})

test('Aleph runner janitor reports expired out-of-scope instances as unswept credit leaks', () => {
  const ownerAddress = `0x${'ab'.repeat(20)}`
  const base = { ownerAddress, status: 'processed' }
  const result = selectExpiredAlephPlaywrightRunners({
    ownerAddress,
    repository: 'NiKrause/simple-todo',
    now: Date.parse('2026-07-28T13:34:00.000Z'),
    ttlMs: 60 * 60_000,
    candidates: [
      // Both orphans from #88, before the prefix was configured: 47 h old and
      // invisible, because "unrecognised name" looked like "nothing to do".
      { ...base, itemHash: 'a'.repeat(64), instanceName: 'simple-todo-e2e-1785074478061', createdAt: '2026-07-26T14:23:00.000Z' },
      { ...base, itemHash: 'b'.repeat(64), instanceName: 'simple-todo-e2e-1785071969399', createdAt: '2026-07-26T13:55:00.000Z' },
      // Out of scope but already deallocated — not a leak.
      { ...base, itemHash: 'c'.repeat(64), instanceName: 'gone', createdAt: '2026-07-26T13:55:00.000Z', status: 'rejected' },
      // Out of scope and young — a run that may still be in flight.
      { ...base, itemHash: 'd'.repeat(64), instanceName: 'fresh', createdAt: '2026-07-28T13:10:00.000Z' },
    ],
  })
  assert.deepEqual(result.expired, [])
  assert.deepEqual(result.unswept.map(({ itemHash }) => itemHash), ['a'.repeat(64), 'b'.repeat(64)])
  assert.deepEqual(result.unswept.map(({ ageMs }) => Math.round(ageMs / 3_600_000)), [47, 48])
})

test('resolveAlephApiHosts enforces api2 then api and excludes api3', () => {
  assert.deepEqual(resolveAlephApiHosts(['https://api.aleph.im/path', 'https://api3.aleph.im', 'https://api2.aleph.im', 'https://untrusted.example']), [
    'https://api2.aleph.im',
    'https://api.aleph.im',
  ])
  assert.deepEqual(resolveAlephApiHosts(['https://api3.aleph.im']), ['https://api2.aleph.im', 'https://api.aleph.im'])
})

test('installEip1193WalletMock exposes accounts and delegates personal_sign', async () => {
  let requestHandler: ((_source: unknown, request: unknown) => Promise<unknown>) | undefined
  let initScriptInstalled = false
  const context = {
    exposeBinding: async (_name: string, handler: typeof requestHandler) => {
      requestHandler = handler
    },
    addInitScript: async () => {
      initScriptInstalled = true
    },
  }
  const account: RelayWalletAccount = {
    address: '0x1234',
    signMessage: async ({ message }) => {
      assert.deepEqual(message, { raw: '0xdeadbeef' })
      return '0xsigned'
    },
  }

  await installEip1193WalletMock(context as never, account)
  assert.equal(initScriptInstalled, true)
  assert.deepEqual(await requestHandler?.({}, { method: 'eth_accounts' }), ['0x1234'])
  assert.equal(await requestHandler?.({}, { method: 'personal_sign', params: ['0xdeadbeef', '0x1234'] }), '0xsigned')
})

test('selectBrowserRelayAddresses keeps authenticated browser transports in preference order', () => {
  const addresses = selectBrowserRelayAddresses({
    browserMultiaddrs: [
      '/dns4/relay.example/tcp/443/tls/ws/p2p/peer',
      '/ip4/203.0.113.2/udp/4001/quic-v1/webtransport/p2p/peer',
      '/ip4/203.0.113.2/udp/4001/quic-v1/webtransport/certhash/uEiHash/p2p/peer',
      '/ip4/203.0.113.2/udp/4002/webrtc-direct/certhash/uEiHash/p2p/peer',
      '/ip4/203.0.113.2/tcp/4003/p2p/peer',
    ],
    multiaddrs: [],
  })

  assert.deepEqual(addresses, [
    '/ip4/203.0.113.2/udp/4001/quic-v1/webtransport/certhash/uEiHash/p2p/peer',
    '/ip4/203.0.113.2/udp/4002/webrtc-direct/certhash/uEiHash/p2p/peer',
    '/dns4/relay.example/tcp/443/tls/ws/p2p/peer',
  ])
})

test('waitForBootstrapRegistration tolerates delayed visibility and does not query api3', async () => {
  const queried: string[] = []
  let attempts = 0
  const registration = await waitForBootstrapRegistration({
    ownerAddress: '0x1234',
    instanceName: 'relay-run-1',
    startedAt: 1_000,
    apiHosts: ['https://api3.aleph.im', 'https://api2.aleph.im'],
    timeoutMs: 1_000,
    pollIntervalMs: 0,
    fetchPosts: async ({ apiHost }) => {
      queried.push(String(apiHost))
      attempts += 1
      if (attempts === 1) return []
      return [
        {
          hash: 'post',
          itemHash: 'post',
          address: '0x1234',
          ref: 'simple-todo-bootstrap',
          type: 'relay-bootstrap-v2',
          time: 1,
          content: {
            peerId: '12D3KooWPeer',
            multiaddrs: ['/dns4/relay.example/tcp/443/tls/ws/p2p/12D3KooWPeer'],
            registrationId: '0x1234:relay-run-1:1',
            ownerAddress: '0x1234',
            updatedAt: 1_000,
          },
        },
      ]
    },
  })

  assert.equal(registration.content?.peerId, '12D3KooWPeer')
  assert.ok(queried.every((host) => host === 'https://api2.aleph.im'))
})

test('waitForAlephInstanceDeletion waits for replica agreement and scheduler deallocation', async () => {
  let api2Observations = 0
  const summary = await waitForAlephInstanceDeletion({
    instanceHash: 'a'.repeat(64),
    timeoutMs: 1_000,
    pollIntervalMs: 0,
    fetch: async (input) => {
      const url = new URL(String(input))
      if (url.hostname === 'scheduler.api.aleph.cloud') {
        return new Response(JSON.stringify({ error: 'VM is not allocated to any node' }), {
          status: 404,
        })
      }
      if (url.hostname === 'api2.aleph.im') api2Observations += 1
      const forgotten = url.hostname !== 'api2.aleph.im' || api2Observations > 1
      return new Response(JSON.stringify({ status: forgotten ? 'forgotten' : 'processed' }))
    },
  })

  assert.equal(api2Observations, 2)
  assert.match(summary, /api2\.aleph\.im: forgotten/)
  assert.match(summary, /scheduler: unallocated/)
})

test('waitForAlephMessageForgotten requires agreement from both Aleph replicas', async () => {
  let api2Observations = 0
  const summary = await waitForAlephMessageForgotten({
    messageHash: 'c'.repeat(64),
    timeoutMs: 1_000,
    pollIntervalMs: 0,
    fetch: async (input) => {
      const url = new URL(String(input))
      if (url.hostname === 'api2.aleph.im') api2Observations += 1
      const forgotten = url.hostname !== 'api2.aleph.im' || api2Observations > 1
      return Response.json({ status: forgotten ? 'forgotten' : 'processed' })
    },
  })

  assert.equal(api2Observations, 2)
  assert.match(summary, /api2\.aleph\.im: forgotten/u)
  assert.match(summary, /api\.aleph\.im: forgotten/u)
})

test('waitForDeployableManifest reports terminal rootfs failures immediately', async () => {
  const page = {
    waitForFunction: async () => ({
      jsonValue: async () => ({ status: 'error', message: 'manifest invalid' }),
    }),
  }

  await assert.rejects(waitForDeployableManifest(page as never), /manifest is not deployable: manifest invalid/)
})

test('waitForPubsubSubscriber waits for topic readiness after the transport connects', async () => {
  const observations = [[], ['12D3KooWRelay']]
  let attempts = 0
  const page = {
    evaluate: async (_callback: unknown, topic: string) => {
      assert.equal(topic, 'consumer-topic')
      const subscribers = observations[Math.min(attempts, observations.length - 1)]
      attempts += 1
      return subscribers
    },
  }

  const subscribers = await waitForPubsubSubscriber(page as never, {
    topic: 'consumer-topic',
    peerId: '12D3KooWRelay',
    timeoutMs: 1_000,
    pollIntervalMs: 0,
    stableForMs: 0,
  })

  assert.deepEqual(subscribers, ['12D3KooWRelay'])
  assert.equal(attempts, 2)
})

test('waitForPubsubSubscriber reports the last observed topic subscribers', async () => {
  const page = {
    evaluate: async () => ['12D3KooWOther'],
  }

  await assert.rejects(
    waitForPubsubSubscriber(page as never, {
      topic: 'consumer-topic',
      peerId: '12D3KooWRelay',
      timeoutMs: 5,
      pollIntervalMs: 0,
      stableForMs: 0,
    }),
    /last subscribers: 12D3KooWOther/,
  )
})

test('cleanupRelay uses awaited owner-signed fallback after UI verification times out', async () => {
  const calls: string[] = []
  let verifyAttempts = 0
  const account: RelayWalletAccount = {
    address: '0x1234',
    signMessage: async () => '0xsigned',
  }
  const driver = {
    requestDelete: async () => {
      calls.push('ui-delete')
    },
  } as unknown as RelayButtonDriver

  const result = await cleanupRelay({
    page: {} as never,
    account,
    instanceName: 'relay-run-1',
    instanceHash: 'b'.repeat(64),
    driver,
    fetch: async () => new Response('{}'),
    hooks: {
      verify: async () => {
        verifyAttempts += 1
        if (verifyAttempts === 1) throw new Error('replicas still disagree')
        calls.push('verified')
        return 'api2: forgotten; api: forgotten; scheduler: unallocated'
      },
      erase: async () => {
        calls.push('erase')
        return {
          status: 'erased',
          crnUrl: 'https://crn.example',
          crnHash: 'crn',
          source: 'provided',
        }
      },
      forget: async () => {
        calls.push('forget')
        return {
          sender: account.address,
          itemHash: 'forget-hash',
          response: {},
          httpStatus: 200,
          status: 'processed',
        }
      },
    },
  })

  assert.equal(result.fallbackUsed, true)
  assert.deepEqual(calls, ['ui-delete', 'erase', 'forget', 'verified'])
})

test('evidence helpers render a reusable GitHub summary', () => {
  const evidence = createRelayEvidence({
    instanceName: 'relay-run-1',
    ownerAddress: '0x1234',
    steps: { provision: 'Relay provisioned', cleanup: 'Relay removed' },
  })
  updateRelayEvidenceStep(evidence, 'provision', 'passed', 'instance-hash')
  updateRelayEvidenceStep(evidence, 'cleanup', 'skipped', 'No deployment submitted')

  const summary = formatRelayGithubSummary(evidence, 'Consumer Relay E2E')
  assert.match(summary, /Consumer Relay E2E/)
  assert.match(summary, /✅ \| Relay provisioned/)
  assert.match(summary, /➖ \| Relay removed/)
})

test('createProgressLogger formats timestamped progress and stage lines', () => {
  const lines = []
  const logger = createProgressLogger({ label: 'remote-repl', log: (line) => lines.push(line) })
  logger.progress('opening browsers')
  logger.stage('connecting-browser-peers')
  logger.stage('deploying', 'provider=aleph')
  assert.match(lines[0], /^\[remote-repl \d{2}:\d{2}:\d{2}\.\d{3}\] opening browsers$/)
  assert.match(lines[1], /^\[remote-repl \d{2}:\d{2}:\d{2}\.\d{3}\] stage: connecting-browser-peers$/)
  assert.match(lines[2], /stage: deploying \(provider=aleph\)$/)
})

test('forwardBrowserConsole forwards matching console + page errors, filters the rest', () => {
  const handlers = {}
  const lines = []
  const page = { on: (event, handler) => (handlers[event] = handler) }
  forwardBrowserConsole(page, { label: 'aleph-remote', log: (line) => lines.push(line) })

  handlers.console({ type: () => 'log', text: () => 'dialing pubsub-discovered peer 12D3KooW' })
  handlers.console({ type: () => 'debug', text: () => 'rendering a react component' }) // filtered out
  handlers.console({ type: () => 'warning', text: () => 'Failed to dial peer' })
  handlers.pageerror(new Error('boom'))

  assert.equal(lines.length, 3)
  assert.match(lines[0], /^\[aleph-remote log\] dialing pubsub-discovered peer/)
  assert.match(lines[1], /^\[aleph-remote warning\] Failed to dial peer$/)
  assert.match(lines[2], /^\[aleph-remote pageerror\] boom$/)
})

test('forwardBrowserConsole with filter null forwards everything and truncates', () => {
  const handlers = {}
  const lines = []
  const page = { on: (event, handler) => (handlers[event] = handler) }
  forwardBrowserConsole(page, { label: 'x', log: (line) => lines.push(line), filter: null, maxLength: 20 })
  handlers.console({ type: () => 'log', text: () => 'a totally unrelated but very long line' })
  assert.equal(lines.length, 1)
  assert.equal(lines[0].length, 20)
  assert.ok(LIBP2P_DIAGNOSTIC_CONSOLE_FILTER.test('circuit reservation'))
})

test('RelayButtonDriver.prepare fills the deploy form by label OR placeholder (Svelte + React parity)', async () => {
  const calls = {
    getByLabel: [] as string[],
    getByPlaceholder: [] as string[],
    getByText: [] as string[],
    getByRole: [] as (string | RegExp | undefined)[],
    fills: [] as string[],
    clicks: 0,
    waited: false,
  }
  const makeLocator = () => {
    const locator: Record<string, unknown> = {}
    locator.or = () => locator
    locator.first = () => locator
    locator.fill = async (value: string) => {
      calls.fills.push(value)
    }
    locator.click = async () => {
      calls.clicks += 1
    }
    locator.waitFor = async () => {
      calls.waited = true
    }
    return locator
  }
  const page = {
    getByLabel: (name: string) => {
      calls.getByLabel.push(name)
      return makeLocator()
    },
    getByPlaceholder: (name: string) => {
      calls.getByPlaceholder.push(name)
      return makeLocator()
    },
    getByText: (name: string) => {
      calls.getByText.push(name)
      return makeLocator()
    },
    getByRole: (_role: string, options?: { name?: string | RegExp }) => {
      calls.getByRole.push(options?.name)
      return makeLocator()
    },
  }

  const driver = new RelayButtonDriver(page as never)
  await driver.prepare({ instanceName: 'demo-instance', sshPublicKey: 'ssh-ed25519 AAAA' })

  // Each field is looked up by BOTH label and placeholder so the driver works
  // for @le-space/ui's Svelte build (labels, no placeholder) and its React
  // build (placeholders) without per-consumer overrides.
  assert.deepEqual(calls.getByLabel, ['Instance Name', 'SSH Public Key'])
  assert.deepEqual(calls.getByPlaceholder, ['Instance name', 'SSH public key'])
  assert.deepEqual(calls.getByText, ['Advanced'])
  assert.deepEqual(calls.getByRole, ['Relay Button', 'Connect MetaMask'])
  assert.deepEqual(calls.fills, ['demo-instance', 'ssh-ed25519 AAAA'])
  assert.equal(calls.waited, true)
  // launcher click + Advanced toggle + Connect wallet
  assert.equal(calls.clicks, 3)
})

// A relay signs its own bootstrap registration, so on a real deployment the
// registration's sender is the relay, not the account running cleanup. Aleph
// only honours a FORGET from the original sender, so awaiting deregistration
// there can only burn `timeoutMs` and throw.
function registrationCleanupHarness(options: {
  accountAddress: string
  registrationSender: string | null
}) {
  const forgotten: string[][] = []
  const account: RelayWalletAccount = {
    address: options.accountAddress,
    signMessage: async () => '0xsigned',
  }
  const driver = {
    requestDelete: async () => {
      throw new Error('page is closed')
    },
  } as unknown as RelayButtonDriver

  return {
    forgotten,
    run: () =>
      cleanupRelay({
        page: {} as never,
        account,
        instanceName: 'relay-run-1',
        instanceHash: 'b'.repeat(64),
        registrationHash: 'c'.repeat(64),
        driver,
        timeoutMs: 1_000,
        pollIntervalMs: 0,
        // The sender lookup and the deregistration poll hit the same
        // `/api/v0/messages/<hash>` URL and read different fields of it, so one
        // response serves both: `message.sender` for ownership, top-level
        // `status` for whether it has been forgotten.
        fetch: async () => {
          if (options.registrationSender === null) throw new Error('replica unreachable')
          return Response.json({
            status: 'forgotten',
            message: { sender: options.registrationSender },
          })
        },
        hooks: {
          verify: async () => 'api: forgotten; scheduler: unallocated',
          erase: async () => ({
            status: 'erased',
            crnUrl: 'https://crn.example',
            crnHash: 'crn',
            source: 'provided',
          }),
          forget: async ({ hashes }) => {
            forgotten.push([...hashes])
            return {
              sender: account.address,
              itemHash: 'forget-hash',
              response: {},
              httpStatus: 200,
              status: 'processed',
            }
          },
        },
      }),
  }
}

test('cleanupRelay does not await a registration the relay owns', async () => {
  const harness = registrationCleanupHarness({
    accountAddress: '0x1234',
    registrationSender: '0xRELAY',
  })

  const result = await harness.run()

  assert.match(result.registrationVerificationSummary ?? '', /belongs to 0xRELAY/u)
  assert.match(result.registrationVerificationSummary ?? '', /only the relay itself/u)
  // The unowned hash must stay out of the FORGET: Aleph rejects the whole
  // request, which would take the INSTANCE down with it and leave a billing VM.
  assert.deepEqual(harness.forgotten, [['b'.repeat(64)]])
})

test('cleanupRelay forgets and awaits a registration it owns, ignoring case', async () => {
  const harness = registrationCleanupHarness({
    accountAddress: '0x1234',
    registrationSender: '0X1234',
  })

  const result = await harness.run()

  assert.deepEqual(harness.forgotten, [['b'.repeat(64), 'c'.repeat(64)]])
  assert.match(result.registrationVerificationSummary ?? '', /forgotten/u)
})

test('cleanupRelay does not await a registration whose sender cannot be read', async () => {
  const harness = registrationCleanupHarness({
    accountAddress: '0x1234',
    registrationSender: null,
  })

  const result = await harness.run()

  // Unreadable is not the same as unowned: a transient API problem must not be
  // escalated into a cleanup failure, nor into an unowned hash in the FORGET.
  assert.match(result.registrationVerificationSummary ?? '', /sender could not be read/u)
  assert.deepEqual(harness.forgotten, [['b'.repeat(64)]])
})

/** A page whose launcher reports a box and whose mouse records what it was told. */
function dragHarness(box = { x: 100, y: 200, width: 40, height: 40 }) {
  const events: string[] = []
  const locator: Record<string, unknown> = {}
  locator.waitFor = async () => {}
  locator.boundingBox = async () => box
  const page = {
    getByRole: () => locator,
    mouse: {
      move: async (x: number, y: number) => {
        events.push(`move ${Math.round(x)},${Math.round(y)}`)
      },
      down: async () => {
        events.push('down')
      },
      up: async () => {
        events.push('up')
      },
    },
  }
  return { page, events, box }
}

test('RelayButtonDriver drags from the launcher centre, in steps, and ends with the button up', async () => {
  const { page, events } = dragHarness()
  const driver = new RelayButtonDriver(page as never)

  const result = await driver.dragLauncherBy(-60, -40, { steps: 4 })

  // From the centre of the launcher (100+20, 200+20), not from its corner: a
  // press on the corner of a round button lands outside it.
  assert.equal(events[0], 'move 120,220')
  assert.equal(events[1], 'down')
  // Intermediate moves, because the widget follows `pointermove` and decides
  // tap-or-drag on the distance travelled. One jump exercises neither the
  // threshold nor the clamping on the way.
  assert.deepEqual(events.slice(2, 6), ['move 105,210', 'move 90,200', 'move 75,190', 'move 60,180'])
  assert.equal(events.at(-1), 'up')

  // Both boxes come back, because every assertion worth making compares them
  // and reading it twice at the call site invites reading it at the wrong time.
  assert.deepEqual(result.before, result.after)
})

test('RelayButtonDriver keeps a wobble under the widget’s own threshold', async () => {
  const { page, events } = dragHarness()
  // The threshold is the widget's number, not the test's — `dragThreshold` in
  // `fab-position.ts`. A driver guessing it would drive a press the widget
  // still reads as a click, and this would silently stop testing anything.
  const driver = new RelayButtonDriver(page as never, { dragThresholdPx: 6 })

  await driver.tapLauncherWithWobble()

  const moved = events.filter((event) => event.startsWith('move')).at(-1) ?? ''
  const [x, y] = moved.replace('move ', '').split(',').map(Number)
  assert.ok(Math.hypot(x - 120, y - 220) < 6, `wobble travelled ${Math.hypot(x - 120, y - 220)}px`)
  assert.deepEqual(events.filter((event) => event === 'down' || event === 'up'), ['down', 'up'])
})

test('RelayButtonDriver says so when the launcher has no box, rather than throwing on null', async () => {
  // A fixed-position launcher inside a wrapper gives the wrapper no box at all;
  // an earlier consumer measured exactly that and got 0×0. A null here means
  // the launcher itself is not rendered, and the message should say which.
  const locator: Record<string, unknown> = {
    waitFor: async () => {},
    boundingBox: async () => null,
  }
  const driver = new RelayButtonDriver({ getByRole: () => locator } as never)

  await assert.rejects(() => driver.launcherBox(), /launcher has no bounding box/)
})
