import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createPortForwardAggregateContent,
  createUnsignedAggregateMessage,
  ensureInstancePortForwards
} from '../src/aggregate-publication.ts'

test('createPortForwardAggregateContent merges requested ports with any existing aggregate entry', () => {
  const result = createPortForwardAggregateContent({
    sender: '0xabc',
    instanceItemHash: 'instanceHash',
    requestedPorts: [
      { port: 22, tcp: true, udp: false, purpose: 'SSH' },
      { port: 9095, tcp: true, udp: true, purpose: 'Relay' }
    ],
    existingAggregate: {
      instanceHash: {
        ports: {
          '9095': { tcp: true, udp: false }
        }
      }
    },
    now: 123
  })

  assert.deepEqual(result, {
    address: '0xabc',
    key: 'port-forwarding',
    content: {
      instanceHash: {
        ports: {
          '22': { tcp: true, udp: false },
          '9095': { tcp: true, udp: true }
        }
      }
    },
    time: 123
  })
})

test('createUnsignedAggregateMessage builds an aggregate message using injected hashing', async () => {
  const result = await createUnsignedAggregateMessage({
    sender: '0xabc',
    content: {
      address: '0xabc',
      key: 'port-forwarding',
      content: {},
      time: 123
    },
    hasher: async () => 'hash123',
    channel: 'TEST',
    now: 123
  })

  assert.equal(result.type, 'AGGREGATE')
  assert.equal(result.item_hash, 'hash123')
  assert.equal(result.channel, 'TEST')
})

test('ensureInstancePortForwards fetches, builds, signs, and broadcasts a port-forward aggregate', async () => {
  const result = await ensureInstancePortForwards({
    sender: '0xabc',
    instanceItemHash: 'instanceHash',
    manifest: {
      profile: 'uc-go-peer',
      version: 'v1',
      rootfsSizeMiB: 20480,
      createdAt: '2026-05-12T07:40:09Z',
      requiredPortForwards: [{ port: 80, tcp: true, udp: false, purpose: 'HTTP' }]
    },
    hasher: async () => 'aggregateHash',
    signer: async () => 'signed1234',
    fetch: async (url, init) => {
      if (String(url).includes('/api/v0/aggregates/')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              data: {
                'port-forwarding': {}
              }
            }
          }
        }
      }

      assert.match(String(url), /api\/v0\/messages$/)
      assert.equal(String(init?.method), 'POST')
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            message_status: 'processed'
          }
        }
      }
    }
  })

  assert.equal(result.aggregateItemHash, 'aggregateHash')
  assert.equal(result.aggregateStatus, 'processed')
  assert.deepEqual(result.requestedPorts, [
    { port: 22, tcp: true, udp: false, purpose: 'SSH' },
    { port: 80, tcp: true, udp: false, purpose: 'HTTP' }
  ])
})

test('ensureInstancePortForwards throws when Aleph rejects the aggregate publication', async () => {
  await assert.rejects(
    () =>
      ensureInstancePortForwards({
        sender: '0xabc',
        instanceItemHash: 'instanceHash',
        manifest: null,
        hasher: async () => 'aggregateHash',
        signer: async () => 'signed1234',
        fetch: async (url) => {
          if (String(url).includes('/api/v0/aggregates/')) {
            return {
              ok: true,
              status: 200,
              async json() {
                return {
                  data: {
                    'port-forwarding': {}
                  }
                }
              }
            }
          }

          return {
            ok: true,
            status: 200,
            async json() {
              return {
                message_status: 'rejected',
                details: { reason: 'nope' }
              }
            }
          }
        }
      }),
    /Port-forward aggregate was rejected/
  )
})
