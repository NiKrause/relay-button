import assert from 'node:assert/strict'
import test from 'node:test'

import {
  cleanupRelay,
  createRelayEvidence,
  formatRelayGithubSummary,
  installEip1193WalletMock,
  resolveAlephApiHosts,
  selectBrowserRelayAddresses,
  updateRelayEvidenceStep,
  waitForAlephInstanceDeletion,
  waitForBootstrapRegistration,
  waitForDeployableManifest,
  waitForPubsubSubscriber,
  type RelayButtonDriver,
  type RelayWalletAccount,
} from '../src/index.ts'

test('resolveAlephApiHosts enforces api2 then api and excludes api3', () => {
  assert.deepEqual(
    resolveAlephApiHosts([
      'https://api.aleph.im/path',
      'https://api3.aleph.im',
      'https://api2.aleph.im',
      'https://untrusted.example',
    ]),
    ['https://api2.aleph.im', 'https://api.aleph.im'],
  )
  assert.deepEqual(resolveAlephApiHosts(['https://api3.aleph.im']), [
    'https://api2.aleph.im',
    'https://api.aleph.im',
  ])
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
  assert.equal(
    await requestHandler?.({}, { method: 'personal_sign', params: ['0xdeadbeef', '0x1234'] }),
    '0xsigned',
  )
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

test('waitForDeployableManifest reports terminal rootfs failures immediately', async () => {
  const page = {
    waitForFunction: async () => ({
      jsonValue: async () => ({ status: 'error', message: 'manifest invalid' }),
    }),
  }

  await assert.rejects(
    waitForDeployableManifest(page as never),
    /manifest is not deployable: manifest invalid/,
  )
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
        return { status: 'erased', crnUrl: 'https://crn.example', crnHash: 'crn', source: 'provided' }
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
