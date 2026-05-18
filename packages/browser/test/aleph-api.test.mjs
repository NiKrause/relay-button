import assert from 'node:assert/strict'
import test from 'node:test'

import {
  broadcastInstanceMessage,
  configureOrbitdbRelaySetup,
  createAlephBrowserClient,
  fetchBalance,
  fetchCrns,
  fetchInstances,
  fetchMessageEnvelope,
  notifyCrnAllocation,
  fetchSchedulerAllocation,
  inspectDeploymentResult,
  normalizeMessageStatus,
  waitForDeploymentResult
} from '../dist/index.js'

test('normalizeMessageStatus keeps supported statuses and maps unknown values', () => {
  assert.equal(normalizeMessageStatus('processed'), 'processed')
  assert.equal(normalizeMessageStatus('PENDING'), 'pending')
  assert.equal(normalizeMessageStatus('bad'), 'unknown')
  assert.equal(normalizeMessageStatus(null), 'unknown')
})

test('fetchBalance requests the public balance API path', async () => {
  const originalFetch = globalThis.fetch

  try {
    let capturedUrl = ''
    globalThis.fetch = async (input) => {
      capturedUrl = String(input)
      return new Response(
        JSON.stringify({
          address: '0xabc',
          balance: '1',
          locked_amount: '0',
          credit_balance: 2
        }),
        { status: 200 }
      )
    }

    const balance = await fetchBalance('0xabc')
    assert.equal(balance.credit_balance, 2)
    assert.match(capturedUrl, /\/api\/v0\/addresses\/0xabc\/balance/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('broadcastInstanceMessage posts signed messages to the Aleph API', async () => {
  const originalFetch = globalThis.fetch

  try {
    let requestBody = null
    let capturedUrl = ''
    globalThis.fetch = async (input, init) => {
      capturedUrl = String(input)
      requestBody = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({ publication_status: { status: 'success' } }), { status: 200 })
    }

    const result = await broadcastInstanceMessage({
      sender: '0xabc',
      chain: 'ETH',
      signature: '0x1234',
      type: 'INSTANCE',
      item_hash: 'a'.repeat(64),
      item_type: 'inline',
      item_content: '{}',
      time: 1,
      channel: 'ALEPH-CLOUDSOLUTIONS'
    })

    assert.match(capturedUrl, /\/api\/v0\/messages/)
    assert.equal(requestBody.message.signature, '0x1234')
    assert.equal(result.httpStatus, 200)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('broadcastInstanceMessage retries with the flattened payload after InvalidMessageFormat', async () => {
  const originalFetch = globalThis.fetch

  try {
    const requestBodies = []
    globalThis.fetch = async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)))

      if (requestBodies.length === 1) {
        return new Response(JSON.stringify({ details: 'InvalidMessageFormat' }), { status: 422 })
      }

      return new Response(JSON.stringify({ publication_status: { status: 'success' } }), { status: 200 })
    }

    await broadcastInstanceMessage({
      sender: '0xabc',
      chain: 'ETH',
      signature: '0x1234',
      type: 'INSTANCE',
      item_hash: 'a'.repeat(64),
      item_type: 'inline',
      item_content: '{}',
      time: 1,
      channel: 'ALEPH-CLOUDSOLUTIONS'
    })

    assert.deepEqual(requestBodies[0], {
      sync: false,
      message: {
        sender: '0xabc',
        chain: 'ETH',
        signature: '0x1234',
        type: 'INSTANCE',
        item_hash: 'a'.repeat(64),
        item_type: 'inline',
        item_content: '{}',
        time: 1,
        channel: 'ALEPH-CLOUDSOLUTIONS'
      }
    })
    assert.deepEqual(requestBodies[1], {
      sender: '0xabc',
      chain: 'ETH',
      signature: '0x1234',
      type: 'INSTANCE',
      item_hash: 'a'.repeat(64),
      item_type: 'inline',
      item_content: '{}',
      time: 1,
      channel: 'ALEPH-CLOUDSOLUTIONS',
      sync: false
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('fetchCrns requests the CRN list with inactive filtering enabled', async () => {
  const originalFetch = globalThis.fetch

  try {
    let capturedUrl = ''
    globalThis.fetch = async (input) => {
      capturedUrl = String(input)
      return new Response(JSON.stringify({ crns: [{ hash: 'abc', name: 'CRN', address: 'https://crn.example' }] }), {
        status: 200
      })
    }

    const crns = await fetchCrns('https://crns-list.aleph.sh/crns.json')
    const url = new URL(capturedUrl)
    assert.equal(crns.length, 1)
    assert.equal(url.searchParams.get('filter_inactive'), 'true')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('fetchInstances requests instance messages and normalizes confirmed items to processed', async () => {
  const originalFetch = globalThis.fetch

  try {
    let capturedUrl = ''
    globalThis.fetch = async (input) => {
      capturedUrl = String(input)
      return new Response(
        JSON.stringify({
          messages: [{ item_hash: 'a'.repeat(64), type: 'INSTANCE', confirmed: true, status: null }]
        }),
        { status: 200 }
      )
    }

    const instances = await fetchInstances('0xabc')
    const url = new URL(capturedUrl)
    assert.equal(url.searchParams.get('msgTypes'), 'INSTANCE')
    assert.equal(url.searchParams.get('addresses'), '0xabc')
    assert.equal(url.searchParams.get('message_statuses'), 'processed,pending,rejected,removing')
    assert.deepEqual(instances, [
      {
        item_hash: 'a'.repeat(64),
        type: 'INSTANCE',
        confirmed: true,
        status: 'processed'
      }
    ])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('fetchSchedulerAllocation requests the scheduler allocation endpoint and normalizes the response', async () => {
  const originalFetch = globalThis.fetch

  try {
    let capturedUrl = ''
    globalThis.fetch = async (input) => {
      capturedUrl = String(input)
      return new Response(
        JSON.stringify({
          vm_hash: 'a'.repeat(64),
          vm_ipv6: '2a02:c207:1:2178::2',
          period: {
            start_timestamp: '2026-04-21T10:00:00Z',
            duration_seconds: 30
          },
          node: {
            node_id: 'crn-dc-12',
            url: 'https://dv1ca.deepvalley.cloud',
            ipv6: '2604:4300::1',
            supports_ipv6: true
          }
        }),
        { status: 200 }
      )
    }

    const allocation = await fetchSchedulerAllocation('a'.repeat(64))
    assert.match(capturedUrl, /https:\/\/scheduler\.api\.aleph\.cloud\/api\/v0\/allocation\//)
    assert.deepEqual(allocation, {
      source: 'scheduler',
      crnUrl: 'https://dv1ca.deepvalley.cloud',
      node: {
        node_id: 'crn-dc-12',
        url: 'https://dv1ca.deepvalley.cloud',
        ipv6: '2604:4300::1',
        supports_ipv6: true
      },
      vmIpv6: '2a02:c207:1:2178::2',
      period: {
        start_timestamp: '2026-04-21T10:00:00Z',
        duration_seconds: 30
      }
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('notifyCrnAllocation posts to the CRN control allocation endpoint', async () => {
  const originalFetch = globalThis.fetch

  try {
    let capturedUrl = ''
    let capturedMethod = ''
    globalThis.fetch = async (input, init) => {
      capturedUrl = String(input)
      capturedMethod = String(init?.method ?? '')
      return new Response('{}', { status: 200 })
    }

    const result = await notifyCrnAllocation('https://selected-crn.example/', 'a'.repeat(64))
    assert.equal(result.status, 'confirmed')
    assert.match(capturedUrl, /https:\/\/selected-crn\.example\/control\/allocation\/notify/)
    assert.equal(capturedMethod, 'POST')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('notifyCrnAllocation treats browser-blocked requests as unconfirmed', async () => {
  const originalFetch = globalThis.fetch

  try {
    globalThis.fetch = async () => {
      throw new TypeError('Failed to fetch')
    }

    const result = await notifyCrnAllocation('https://selected-crn.example/', 'a'.repeat(64))
    assert.deepEqual(result, { status: 'unconfirmed' })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('configureOrbitdbRelaySetup posts the relay setup payload to the setup endpoint', async () => {
  const originalFetch = globalThis.fetch

  try {
    let capturedUrl = ''
    let capturedBody = null
    globalThis.fetch = async (input, init) => {
      capturedUrl = String(input)
      capturedBody = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({ status: 'configured' }), { status: 200 })
    }

    const result = await configureOrbitdbRelaySetup({
      hostIpv4: '62.141.40.252',
      publicIpv6: '2a01:4f8:c010:4b5::42',
      setupPort: 28080,
      tcpPort: 28191,
      wsPort: 28192,
      proxyUrl: 'https://dragon-belt-friend-share.2n6.me',
      metricsPort: 28190,
      metricsHttpsPort: 29443,
      webrtcPort: 28193,
      quicPort: 28194
    })

    assert.deepEqual(result, { status: 'configured' })
    assert.match(capturedUrl, /^http:\/\/62\.141\.40\.252:28080\/configure\?_ts=\d+$/)
    assert.deepEqual(capturedBody, {
      public_ipv4: '62.141.40.252',
      public_ipv6: '2a01:4f8:c010:4b5::42',
      tcp_port: 28191,
      ws_port: 28192,
      proxy_url: 'https://dragon-belt-friend-share.2n6.me',
      metrics_port: 28190,
      metrics_https_port: 29443,
      webrtc_port: 28193,
      quic_port: 28194
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('configureOrbitdbRelaySetup treats timed out setup requests as unconfirmed', async () => {
  const originalFetch = globalThis.fetch

  try {
    globalThis.fetch = async () =>
      new Promise((_, reject) => {
        setTimeout(() => reject(new DOMException('The operation was aborted.', 'AbortError')), 0)
      })

    const result = await configureOrbitdbRelaySetup({
      hostIpv4: '62.141.40.252',
      setupPort: 28080,
      tcpPort: 28191,
      wsPort: 28192
    })

    assert.deepEqual(result, { status: 'unconfirmed' })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('fetchMessageEnvelope returns null for a missing message', async () => {
  const originalFetch = globalThis.fetch

  try {
    globalThis.fetch = async () => new Response('', { status: 404 })
    const payload = await fetchMessageEnvelope('a'.repeat(64))
    assert.equal(payload, null)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('inspectDeploymentResult resolves related references and rejection reason', async () => {
  const originalFetch = globalThis.fetch

  try {
    globalThis.fetch = async (input) => {
      const url = String(input)

      if (url.startsWith(`https://api2.aleph.im/api/v0/messages/${'a'.repeat(64)}`)) {
        return new Response(
          JSON.stringify({
            status: 'rejected',
            error_code: 13,
            details: { errors: ['b'.repeat(64)] }
          }),
          { status: 200 }
        )
      }

      if (url.startsWith(`https://api2.aleph.im/api/v0/messages/${'b'.repeat(64)}`)) {
        return new Response(
          JSON.stringify({
            status: 'pending',
            type: 'store'
          }),
          { status: 200 }
        )
      }

      throw new Error(`Unexpected URL ${url}`)
    }

    const result = await inspectDeploymentResult('a'.repeat(64), 'b'.repeat(64))
    assert.equal(result.status, 'rejected')
    assert.equal(result.errorCode, 13)
    assert.equal(result.references.length, 1)
    assert.equal(result.references[0].status, 'pending')
    assert.match(result.rejectionReason ?? '', /still pending/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('waitForDeploymentResult polls until the message reaches a terminal state', async () => {
  const originalFetch = globalThis.fetch
  const originalSetTimeout = globalThis.setTimeout

  try {
    let calls = 0
    globalThis.fetch = async () => {
      calls += 1
      return new Response(JSON.stringify({ status: calls === 1 ? 'pending' : 'processed' }), { status: 200 })
    }
    globalThis.setTimeout = ((fn) => {
      fn()
      return 0
    })

    const result = await waitForDeploymentResult('a'.repeat(64), undefined, undefined, 3, 1)
    assert.equal(result.status, 'processed')
    assert.equal(calls, 2)
  } finally {
    globalThis.fetch = originalFetch
    globalThis.setTimeout = originalSetTimeout
  }
})

test('createAlephBrowserClient binds apiHost and crnListUrl defaults into reusable methods', async () => {
  const originalFetch = globalThis.fetch

  try {
    const urls = []
    globalThis.fetch = async (input) => {
      urls.push(String(input))

      if (String(input).includes('/balance')) {
        return new Response(
          JSON.stringify({
            address: '0xabc',
            balance: '1',
            locked_amount: '0',
            credit_balance: 2
          }),
          { status: 200 }
        )
      }

      return new Response(JSON.stringify({ crns: [] }), { status: 200 })
    }

    const client = createAlephBrowserClient({
      apiHost: 'https://api.example',
      crnListUrl: 'https://crns.example/list.json'
    })

    await client.fetchBalance('0xabc')
    await client.fetchCrns()
    globalThis.fetch = async () => new Response('', { status: 404 })
    await client.fetchSchedulerAllocation('a'.repeat(64))

    assert.equal(client.apiHost, 'https://api.example')
    assert.equal(client.crnListUrl, 'https://crns.example/list.json')
    assert.equal(client.schedulerApiHost, 'https://scheduler.api.aleph.cloud')
    assert.match(urls[0], /https:\/\/api\.example\/api\/v0\/addresses\/0xabc\/balance/)
    assert.match(urls[1], /https:\/\/crns\.example\/list\.json/)
  } finally {
    globalThis.fetch = originalFetch
  }
})
