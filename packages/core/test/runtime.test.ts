import test from 'node:test'
import assert from 'node:assert/strict'

import {
  describeRuntimeAvailability,
  fetch2n6WebAccessUrl,
  fetchCrnExecutionMap,
  fetchSchedulerAllocation,
  fetchVmRuntime,
  waitForVmRuntime
} from '../src/runtime.ts'

function jsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload
    }
  }
}

test('fetchSchedulerAllocation normalizes scheduler allocation payloads', async () => {
  const result = await fetchSchedulerAllocation('instance-1', {
    fetch: async () =>
      jsonResponse({
        node: {
          node_id: 'crn-1',
          url: 'https://crn.example.com',
          ipv6: '2001:db8::1',
          supports_ipv6: true
        },
        vm_ipv6: '2001:db8::2',
        period: {
          start_timestamp: '2026-05-14T00:00:00Z',
          duration_seconds: 30
        }
      })
  })

  assert.equal(result?.source, 'scheduler')
  assert.equal(result?.crnHash, 'crn-1')
  assert.equal(result?.crnUrl, 'https://crn.example.com')
  assert.equal(result?.vmIpv6, '2001:db8::2')
})

test('fetch2n6WebAccessUrl normalizes proxy url payloads', async () => {
  const result = await fetch2n6WebAccessUrl('instance-1', {
    fetch: async () =>
      jsonResponse({
        subdomain: 'relay.example.com',
        active: false
      })
  })

  assert.equal(result?.url, 'https://relay.example.com')
  assert.equal(result?.active, false)
})

test('fetchCrnExecutionMap prefers v2 and falls back to v1', async () => {
  let callCount = 0
  const result = await fetchCrnExecutionMap('https://crn.example.com', {
    fetch: async (url) => {
      callCount += 1
      if (String(url).endsWith('/v2/about/executions/list')) {
        return jsonResponse({}, 404)
      }
      return jsonResponse({ abc: {} })
    }
  })

  assert.equal(callCount, 2)
  assert.equal(result.version, 'v1')
  assert.deepEqual(result.payload, { abc: {} })
})

test('describeRuntimeAvailability reports ready runtime when host IPv4 and mapped ports exist', () => {
  const result = describeRuntimeAvailability({
    allocation: { source: 'scheduler' },
    execution: { crnUrl: 'https://crn.example.com', version: 'v2', networking: { mapped_ports: {} } },
    hostIpv4: '203.0.113.9',
    proxyUrl: 'https://relay.example.com',
    mappedPorts: { '22': { host: 32022, tcp: true } }
  })

  assert.equal(result.state, 'ready')
  assert.equal(result.reason, null)
})

test('describeRuntimeAvailability reports invalid guest IPv6 for proxy-backed runtime', () => {
  const result = describeRuntimeAvailability({
    allocation: { source: 'scheduler' },
    execution: { crnUrl: 'https://crn.example.com', version: 'v2', networking: { mapped_ports: {} } },
    hostIpv4: '203.0.113.9',
    ipv6: 'fc00:1:2:3::42',
    proxyUrl: 'https://relay.example.com',
    mappedPorts: { '22': { host: 32022, tcp: true } },
    requirePublicGuestIpv6ForProxy: true
  })

  assert.equal(result.state, 'execution-invalid-public-ipv6')
  assert.match(result.reason ?? '', /not globally routable/i)
})

test('fetchVmRuntime combines allocation, execution, and web access details', async () => {
  const result = await fetchVmRuntime({
    itemHash: 'instance-1',
    crnHash: 'crn-1',
    crns: [{ hash: 'crn-1', address: 'https://crn.example.com', name: 'CRN One' }],
    fetch: async (url) => {
      if (String(url).includes('scheduler.api.aleph.cloud')) {
        return jsonResponse({
          node: {
            node_id: 'crn-1',
            url: 'https://crn.example.com'
          },
          vm_ipv6: '2001:db8::2'
        })
      }
      if (String(url).includes('api.2n6.me')) {
        return jsonResponse({
          url: 'https://relay.example.com',
          active: true
        })
      }
      if (String(url).includes('/v2/about/executions/list')) {
        return jsonResponse({
          'instance-1': {
            running: true,
            networking: {
              host_ipv4: '203.0.113.9',
              ipv6_ip: '2001:db8::2',
              mapped_ports: {
                '22': { host: 32022, tcp: true, udp: false },
                '443': { host: 32443, tcp: true, udp: false }
              }
            }
          }
        })
      }
      throw new Error(`Unexpected URL ${String(url)}`)
    }
  })

  assert.equal(result.hostIpv4, '203.0.113.9')
  assert.equal(result.proxyUrl, 'https://relay.example.com')
  assert.equal(result.sshCommand, 'ssh root@203.0.113.9 -p 32022')
  assert.equal(result.diagnostics?.state, 'ready')
  assert.equal(result.selectedCrn?.hash, 'crn-1')
})

test('waitForVmRuntime polls until runtime networking is ready', async () => {
  let attempts = 0
  const result = await waitForVmRuntime({
    itemHash: 'instance-1',
    crnHash: 'crn-1',
    crns: [{ hash: 'crn-1', address: 'https://crn.example.com' }],
    attempts: 3,
    delayMs: 1,
    sleep: async () => undefined,
    fetch: async (url) => {
      if (String(url).includes('scheduler.api.aleph.cloud')) {
        return jsonResponse({
          node: {
            node_id: 'crn-1',
            url: 'https://crn.example.com'
          }
        })
      }
      if (String(url).includes('api.2n6.me')) {
        return jsonResponse({}, 404)
      }
      if (String(url).includes('/v2/about/executions/list')) {
        attempts += 1
        return jsonResponse({
          'instance-1':
            attempts >= 2
              ? {
                  networking: {
                    host_ipv4: '203.0.113.10',
                    mapped_ports: {
                      '22': { host: 32022, tcp: true, udp: false }
                    }
                  }
                }
              : {
                  networking: {
                    mapped_ports: {}
                  }
                }
        })
      }
      throw new Error(`Unexpected URL ${String(url)}`)
    }
  })

  assert.equal(result.hostIpv4, '203.0.113.10')
  assert.equal(result.diagnostics?.state, 'ready')
})

test('waitForVmRuntime returns early when proxy-backed runtime exposes only non-public guest IPv6', async () => {
  let attempts = 0
  const result = await waitForVmRuntime({
    itemHash: 'instance-1',
    crnHash: 'crn-1',
    crns: [{ hash: 'crn-1', address: 'https://crn.example.com' }],
    requirePublicGuestIpv6ForProxy: true,
    attempts: 2,
    delayMs: 1,
    sleep: async () => undefined,
    fetch: async (url) => {
      if (String(url).includes('scheduler.api.aleph.cloud')) {
        return jsonResponse({
          node: {
            node_id: 'crn-1',
            url: 'https://crn.example.com'
          }
        })
      }
      if (String(url).includes('api.2n6.me')) {
        return jsonResponse({
          url: 'https://relay.example.com',
          active: true
        })
      }
      if (String(url).includes('/v2/about/executions/list')) {
        attempts += 1
        return jsonResponse({
          'instance-1': {
            networking: {
              host_ipv4: '203.0.113.10',
              ipv6_ip: 'fc00:1:2:3::10',
              mapped_ports: {
                '22': { host: 32022, tcp: true, udp: false }
              }
            }
          }
        })
      }
      throw new Error(`Unexpected URL ${String(url)}`)
    }
  })

  assert.equal(attempts, 1)
  assert.equal(result.hostIpv4, '203.0.113.10')
  assert.equal(result.diagnostics?.state, 'execution-invalid-public-ipv6')
  assert.equal(result.diagnostics?.timedOut, undefined)
})
