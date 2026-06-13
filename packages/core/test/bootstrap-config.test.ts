import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createVmBootstrapConfigAggregateContent,
  fetchVmBootstrapConfigSignals,
  listStaleVmBootstrapConfigAggregateMessageHashes,
  waitForVmBootstrapConfigSignal,
} from '../src/bootstrap-config.ts'

test('fetchVmBootstrapConfigSignals filters matching status posts', async () => {
  const signals = await fetchVmBootstrapConfigSignals({
    deploymentToken: 'deploy-123',
    ownerAddress: '0xOwner',
    instanceItemHash: 'instance-hash',
    fetch: async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          posts: [
            {
              content: {
                deploymentToken: 'deploy-123',
                status: 'applied',
                profile: 'uc-go-peer',
                ownerAddress: '0xowner',
                instanceItemHash: 'instance-hash',
                updatedAt: '2026-06-09T12:00:00Z',
                publisherAddress: '0xpublisher',
              },
            },
            {
              content: {
                deploymentToken: 'other',
                status: 'applied',
                profile: 'uc-go-peer',
                ownerAddress: '0xowner',
                instanceItemHash: 'instance-hash',
                updatedAt: '2026-06-09T12:00:00Z',
              },
            },
          ],
        }
      },
    }),
  })

  assert.equal(signals.length, 1)
  assert.equal(signals[0]?.deploymentToken, 'deploy-123')
  assert.equal(signals[0]?.publisherAddress, '0xpublisher')
})

test('waitForVmBootstrapConfigSignal resolves once the applied signal appears', async () => {
  let attempts = 0

  const signal = await waitForVmBootstrapConfigSignal({
    deploymentToken: 'deploy-123',
    ownerAddress: '0xowner',
    instanceItemHash: 'instance-hash',
    attempts: 3,
    delayMs: 0,
    sleep: async () => undefined,
    fetch: async () => {
      attempts += 1
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            posts:
              attempts < 2
                ? []
                : [
                    {
                      item_content: JSON.stringify({
                        type: 'vm-bootstrap-config-status',
                        address: '0xpublisher',
                        ref: 'vm-bootstrap-config',
                        content: {
                          deploymentToken: 'deploy-123',
                          status: 'applied',
                          profile: 'uc-go-peer',
                          ownerAddress: '0xowner',
                          instanceItemHash: 'instance-hash',
                          updatedAt: '2026-06-09T12:00:00Z',
                        },
                      }),
                    },
                  ],
          }
        },
      }
    },
  })

  assert.equal(attempts, 2)
  assert.equal(signal?.status, 'applied')
  assert.equal(signal?.deploymentToken, 'deploy-123')
})

test('createVmBootstrapConfigAggregateContent prunes expired stale records before appending the new token', () => {
  const content = createVmBootstrapConfigAggregateContent({
    sender: '0xowner',
    now: Date.parse('2026-06-13T12:00:00Z') / 1000,
    record: {
      deploymentToken: 'fresh-token',
      profile: 'uc-go-peer',
      ownerAddress: '0xowner',
      instanceItemHash: 'instance-fresh',
      createdAt: '2026-06-13T12:00:00Z',
      expiresAt: '2026-06-13T12:30:00Z',
      status: 'pending',
      runtime: {
        publicIpv4: '1.2.3.4',
        publicIpv6: null,
        proxyUrl: null,
        mappedPorts: {},
      },
    },
    existingAggregate: {
      stale: {
        deploymentToken: 'stale',
        profile: 'uc-go-peer',
        ownerAddress: '0xowner',
        instanceItemHash: 'instance-stale',
        createdAt: '2026-06-13T04:00:00Z',
        expiresAt: '2026-06-13T04:30:00Z',
        status: 'pending',
        runtime: {
          publicIpv4: '1.2.3.4',
          publicIpv6: null,
          proxyUrl: null,
          mappedPorts: {},
        },
      },
      malformed: {
        deploymentToken: '',
      } as never,
    },
  })

  assert.deepEqual(Object.keys(content.content), ['fresh-token'])
})

test('listStaleVmBootstrapConfigAggregateMessageHashes returns only old superseded vm-bootstrap-config aggregates', async () => {
  const hashes = await listStaleVmBootstrapConfigAggregateMessageHashes({
    address: '0xowner',
    currentAggregateItemHash: 'current-hash',
    olderThanMs: 6 * 60 * 60 * 1000,
    nowMs: Date.parse('2026-06-13T12:00:00Z'),
    fetch: async (url) => ({
      ok: true,
      status: 200,
      async json() {
        const requestUrl = new URL(String(url))
        const page = Number(requestUrl.searchParams.get('page') ?? '1')
        return {
          messages:
            page === 1
              ? [
                  {
                    item_hash: 'current-hash',
                    time: Date.parse('2026-06-13T11:59:00Z') / 1000,
                    content: {
                      key: 'vm-bootstrap-config',
                    },
                  },
                  {
                    item_hash: 'recent-hash',
                    time: Date.parse('2026-06-13T10:00:00Z') / 1000,
                    content: {
                      key: 'vm-bootstrap-config',
                    },
                  },
                  {
                    item_hash: 'old-hash',
                    time: Date.parse('2026-06-13T04:30:00Z') / 1000,
                    content: {
                      key: 'vm-bootstrap-config',
                    },
                  },
                  {
                    item_hash: 'other-key',
                    time: Date.parse('2026-06-13T02:00:00Z') / 1000,
                    content: {
                      key: 'port-forwarding',
                    },
                  },
                ]
              : [],
        }
      },
    }),
  })

  assert.deepEqual(hashes, ['old-hash'])
})
