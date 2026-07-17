import assert from 'node:assert/strict'
import test from 'node:test'

import {
  broadcastInstanceMessage,
  configureOrbitdbRelaySetup,
  createAlephBrowserClient,
  fetchBalance,
  fetch2n6WebAccessUrl,
  fetchCrnExecutionMap,
  fetchCrns,
  fetchInstances,
  fetchMessageEnvelope,
  notifyCrnAllocation,
  normalizeExecution,
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
    assert.equal(url.searchParams.get('message_statuses'), 'processed,pending,rejected')
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

test('fetchInstances defaults missing fresh-instance status to pending', async () => {
  const originalFetch = globalThis.fetch

  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          messages: [{ item_hash: 'b'.repeat(64), type: 'INSTANCE', confirmed: false, status: null }]
        }),
        { status: 200 }
      )

    const instances = await fetchInstances('0xabc')
    assert.deepEqual(instances, [
      {
        item_hash: 'b'.repeat(64),
        type: 'INSTANCE',
        confirmed: false,
        status: 'pending'
      }
    ])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('fetch2n6WebAccessUrl normalizes bare subdomains into https URLs', async () => {
  const originalFetch = globalThis.fetch

  try {
    let capturedUrl = ''
    globalThis.fetch = async (input) => {
      capturedUrl = String(input)
      return new Response(JSON.stringify({ subdomain: 'relay.example' }), { status: 200 })
    }

    const webAccessUrl = await fetch2n6WebAccessUrl('a'.repeat(64))
    assert.match(capturedUrl, /https:\/\/api\.2n6\.me\/api\/hash\//)
    assert.equal(webAccessUrl, 'https://relay.example')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('fetch2n6WebAccessUrl returns null for missing 2n6 records', async () => {
  const originalFetch = globalThis.fetch

  try {
    globalThis.fetch = async () => new Response('', { status: 404 })
    const webAccessUrl = await fetch2n6WebAccessUrl('b'.repeat(64))
    assert.equal(webAccessUrl, null)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('fetchCrnExecutionMap prefers v2 execution lists and reports the version', async () => {
  const originalFetch = globalThis.fetch

  try {
    const calls = []
    globalThis.fetch = async (input) => {
      calls.push(String(input))
      return new Response(JSON.stringify({ ['a'.repeat(64)]: { networking: { host_ipv4: '203.0.113.10' } } }), {
        status: 200
      })
    }

    const result = await fetchCrnExecutionMap('https://selected-crn.example/')
    assert.equal(calls.length, 1)
    assert.match(calls[0], /^https:\/\/selected-crn\.example\/v2\/about\/executions\/list(?:\?_ts=\d+)?$/)
    assert.equal(result.blocked, false)
    assert.equal(result.version, 'v2')
    assert.equal(result.requestUrl, 'https://selected-crn.example/v2/about/executions/list')
    assert.equal(typeof result.payload, 'object')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('fetchCrnExecutionMap falls back to v1 when the v2 endpoint is missing', async () => {
  const originalFetch = globalThis.fetch

  try {
    let callIndex = 0
    globalThis.fetch = async () => {
      callIndex += 1
      if (callIndex === 1) {
        return new Response('', { status: 404 })
      }

      return new Response(JSON.stringify({ ['b'.repeat(64)]: { networking: { ipv4: '198.51.100.10' } } }), {
        status: 200
      })
    }

    const result = await fetchCrnExecutionMap('https://selected-crn.example')
    assert.equal(result.blocked, false)
    assert.equal(result.version, 'v1')
    assert.equal(result.requestUrl, 'https://selected-crn.example/about/executions/list')
    assert.equal(typeof result.payload, 'object')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('fetchCrnExecutionMap treats browser-blocked CRN requests as blocked', async () => {
  const originalFetch = globalThis.fetch

  try {
    globalThis.fetch = async () => {
      throw new TypeError('Failed to fetch')
    }

    const result = await fetchCrnExecutionMap('https://selected-crn.example')
    assert.equal(result.blocked, true)
    assert.equal(result.version, 'v2')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('normalizeExecution maps v2 execution payloads into shared runtime shape', () => {
  const execution = normalizeExecution(
    {
      networking: {
        host_ipv4: '149.86.227.106',
        ipv4_ip: '172.16.7.2',
        mapped_ports: {
          '22': {
            host: 24008,
            tcp: true,
            udp: false
          }
        }
      },
      web_access: {
        url: 'dragon-belt-friend-share.2n6.me'
      },
      status: {
        started_at: '2026-04-24T15:56:47Z'
      },
      running: true
    },
    'https://selected-crn.example'
  )

  assert.deepEqual(execution, {
    crnUrl: 'https://selected-crn.example',
    version: 'v2',
    running: true,
    networking: {
      ipv4_network: null,
      host_ipv4: '149.86.227.106',
      ipv6_network: null,
      ipv6_ip: null,
      ipv4_ip: '172.16.7.2',
      proxy_url: 'https://dragon-belt-friend-share.2n6.me',
      mapped_ports: {
        '22': {
          host: 24008,
          tcp: true,
          udp: false
        }
      }
    },
    status: {
      defined_at: null,
      preparing_at: null,
      prepared_at: null,
      starting_at: null,
      started_at: '2026-04-24T15:56:47Z',
      stopping_at: null,
      stopped_at: null
    }
  })
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

test('inspectDeploymentResult explains insufficient balance rejections even for error 6', async () => {
  const originalFetch = globalThis.fetch

  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          status: 'rejected',
          error_code: 6,
          details: {
            errors: [
              {
                account_balance: 0,
                required_balance: 14250
              }
            ]
          }
        }),
        { status: 200 }
      )

    const result = await inspectDeploymentResult('a'.repeat(64))
    assert.equal(result.status, 'rejected')
    assert.match(result.rejectionReason ?? '', /insufficient Aleph balance/i)
    assert.match(result.rejectionReason ?? '', /14250\.000 required/i)
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


test('createAlephBrowserClient retries Aleph API reads across apiHosts', async () => {
  const originalFetch = globalThis.fetch

  try {
    const urls = []
    globalThis.fetch = async (input) => {
      urls.push(String(input))
      if (String(input).startsWith('https://api.aleph.im/')) {
        return new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 })
      }
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

    const client = createAlephBrowserClient({
      apiHosts: 'https://api.aleph.im, https://api2.aleph.im'
    })

    const balance = await client.fetchBalance('0xabc')

    assert.equal(balance.address, '0xabc')
    assert.deepEqual(client.apiHosts, ['https://api.aleph.im', 'https://api2.aleph.im'])
    assert.match(urls[0], /https:\/\/api\.aleph\.im\/api\/v0\/addresses\/0xabc\/balance/)
    assert.match(urls[1], /https:\/\/api2\.aleph\.im\/api\/v0\/addresses\/0xabc\/balance/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('createAlephBrowserClient filters the unsupported api3 host', () => {
  const client = createAlephBrowserClient({
    apiHosts: 'https://api3.aleph.im, https://api.aleph.im'
  })

  assert.deepEqual(client.apiHosts, ['https://api.aleph.im'])
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
    assert.deepEqual(client.apiHosts, ['https://api.example'])
    assert.equal(client.crnListUrl, 'https://crns.example/list.json')
    assert.equal(client.schedulerApiHost, 'https://scheduler.api.aleph.cloud')
    assert.match(urls[0], /https:\/\/api\.example\/api\/v0\/addresses\/0xabc\/balance/)
    assert.match(urls[1], /https:\/\/crns\.example\/list\.json/)
  } finally {
    globalThis.fetch = originalFetch
  }
})
