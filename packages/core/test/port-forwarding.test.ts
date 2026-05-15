import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_INSTANCE_PORT_FORWARDS,
  fetchPortForwardAggregate,
  mergePortFlagMaps,
  mergeRequiredPortForwards,
  normalizeExistingPortForwardEntry,
  portForwardLabel,
  requestedPortFlags,
  requiredInstancePortForwards
} from '../src/port-forwarding.ts'

test('mergeRequiredPortForwards keeps ports sorted and merges protocol flags', () => {
  const result = mergeRequiredPortForwards(
    [{ port: 9095, tcp: true, udp: false, purpose: 'TCP' }],
    [{ port: 9095, tcp: false, udp: true, purpose: 'UDP' }],
    [{ port: 80, tcp: true, udp: false, purpose: 'HTTP' }]
  )

  assert.deepEqual(result, [
    { port: 80, tcp: true, udp: false, purpose: 'HTTP' },
    { port: 9095, tcp: true, udp: true, purpose: 'TCP' }
  ])
})

test('requiredInstancePortForwards includes SSH by default', () => {
  const result = requiredInstancePortForwards({
    version: 'test',
    rootfsSizeMiB: 1024,
    createdAt: '2026-05-12T07:40:09Z',
    requiredPortForwards: [{ port: 80, tcp: true, udp: false, purpose: 'HTTP' }]
  })

  assert.deepEqual(result, [
    ...DEFAULT_INSTANCE_PORT_FORWARDS,
    { port: 80, tcp: true, udp: false, purpose: 'HTTP' }
  ])
})

test('requestedPortFlags converts requested forwards into aggregate-ready shape', () => {
  const result = requestedPortFlags([
    { port: 22, tcp: true, udp: false },
    { port: 9095, tcp: true, udp: true }
  ])

  assert.deepEqual(result, {
    '22': { tcp: true, udp: false },
    '9095': { tcp: true, udp: true }
  })
})

test('normalizeExistingPortForwardEntry ignores invalid entries', () => {
  const result = normalizeExistingPortForwardEntry({
    ports: {
      '22': { tcp: true, udp: false },
      'bad': null as unknown as { tcp: boolean; udp: boolean }
    }
  })

  assert.deepEqual(result, {
    '22': { tcp: true, udp: false }
  })
})

test('mergePortFlagMaps unions protocol flags per port', () => {
  const result = mergePortFlagMaps(
    { '9095': { tcp: true, udp: false } },
    { '9095': { tcp: false, udp: true }, '80': { tcp: true, udp: false } }
  )

  assert.deepEqual(result, {
    '80': { tcp: true, udp: false },
    '9095': { tcp: true, udp: true }
  })
})

test('portForwardLabel formats tcp/udp display labels', () => {
  assert.equal(portForwardLabel({ port: 9095, tcp: true, udp: true }), '9095/TCP/UDP')
  assert.equal(portForwardLabel({ port: 80, tcp: true, udp: false }), '80/TCP')
})

test('fetchPortForwardAggregate reads the port-forwarding aggregate from Aleph aggregate payloads', async () => {
  const result = await fetchPortForwardAggregate('0xabc', {
    fetch: async (url) => {
      assert.match(url, /keys=port-forwarding/)
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            data: {
              'port-forwarding': {
                instanceHash: {
                  ports: {
                    '22': { tcp: true, udp: false }
                  }
                }
              }
            }
          }
        }
      }
    }
  })

  assert.deepEqual(result, {
    instanceHash: {
      ports: {
        '22': { tcp: true, udp: false }
      }
    }
  })
})

test('fetchPortForwardAggregate returns empty object for 404 lookups', async () => {
  const result = await fetchPortForwardAggregate('0xabc', {
    fetch: async () => ({
      ok: false,
      status: 404,
      async json() {
        return {}
      }
    })
  })

  assert.deepEqual(result, {})
})
