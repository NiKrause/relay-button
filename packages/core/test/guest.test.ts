import test from 'node:test'
import assert from 'node:assert/strict'

import {
  configureUcGoPeer,
  fetchUcGoPeerMetadata,
  notifyCrnAllocation,
  verifyUcGoPeerReachability,
  waitForSetupEndpoint
} from '../src/guest.ts'

function jsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url: 'https://example.com/final',
    async json() {
      return payload
    }
  }
}

test('notifyCrnAllocation skips missing CRN URLs and confirms successful notifies', async () => {
  assert.equal(
    (await notifyCrnAllocation({
      crnUrl: '',
      itemHash: 'instance-1',
      fetch: async () => jsonResponse({})
    })).status,
    'skipped'
  )

  const confirmed = await notifyCrnAllocation({
    crnUrl: 'https://crn.example.com/',
    itemHash: 'instance-1',
    fetch: async (url, init) => {
      assert.equal(String(url), 'https://crn.example.com/control/allocation/notify')
      assert.equal(init?.method, 'POST')
      return jsonResponse({ ok: true })
    }
  })

  assert.equal(confirmed.status, 'confirmed')
})

test('waitForSetupEndpoint polls the setup health endpoint until reachable', async () => {
  let attempts = 0
  const result = await waitForSetupEndpoint({
    hostIpv4: '203.0.113.5',
    setupPort: 30080,
    attempts: 3,
    delayMs: 1,
    sleep: async () => undefined,
    fetch: async () => {
      attempts += 1
      return jsonResponse({}, attempts >= 2 ? 200 : 503)
    }
  })

  assert.equal(result.ok, true)
})

test('configureUcGoPeer posts the expected payload to the guest', async () => {
  let body = ''
  const result = await configureUcGoPeer({
    hostIpv4: '203.0.113.5',
    publicIpv6: '2001:db8::5',
    setupPort: 30080,
    tcpPort: 32095,
    wsPort: 32097,
    udpPort: 32095,
    quicPort: 32095,
    webrtcPort: 32095,
    proxyUrl: 'https://relay.example.com',
    fetch: async (_url, init) => {
      body = String(init?.body ?? '')
      return jsonResponse({ status: 'configured' })
    }
  })

  assert.deepEqual(result, { status: 'configured' })
  assert.match(body, /"public_ipv4":"203\.0\.113\.5"/)
  assert.match(body, /"proxy_url":"https:\/\/relay\.example\.com"/)
})

test('fetchUcGoPeerMetadata waits until the guest reports ready metadata', async () => {
  let attempts = 0
  const result = await fetchUcGoPeerMetadata({
    hostIpv4: '203.0.113.5',
    setupPort: 30080,
    attempts: 3,
    delayMs: 1,
    sleep: async () => undefined,
    fetch: async () => {
      attempts += 1
      return jsonResponse(
        attempts >= 2
          ? { status: 'ready', metadata: { peer_id: '12D3KooW', probe_multiaddrs: [] } }
          : { status: 'configuring' }
      )
    }
  })

  assert.deepEqual(result, { status: 'ready', metadata: { peer_id: '12D3KooW', probe_multiaddrs: [] } })
})

test('verifyUcGoPeerReachability checks mapped TCP ports, proxy HTTP, proxy TCP, and UDP notes', async () => {
  const result = await verifyUcGoPeerReachability({
    hostIpv4: '203.0.113.5',
    mappedPorts: {
      '80': { host: 30080, tcp: true },
      '443': { host: 30443, tcp: true },
      '9095': { host: 32095, tcp: true, udp: true }
    },
    proxyUrl: 'https://relay.example.com',
    skipInternalPorts: ['80'],
    fetch: async () => jsonResponse({}),
    httpProbe: async () => ({ ok: true, status: 200, url: 'https://relay.example.com' }),
    tcpProbe: async (_host, port) => ({ ok: port !== 443, error: port === 443 ? 'closed' : undefined })
  })

  assert.equal(result.ok, false)
  assert.equal(result.checks['https:proxy'].ok, true)
  assert.equal(result.checks['tcp:443'].ok, true)
  assert.equal(result.checks['tcp:9095'].ok, true)
  assert.equal(result.checks['tcp:proxy-443'].ok, false)
})
