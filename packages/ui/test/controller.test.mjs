import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createSponsorRelayController,
} from '../dist/shared/index.mjs'

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url: 'https://example.test',
    async json() {
      return payload
    }
  }
}

test('controller waits for active 2n6 web access before publishing guest proxyUrl', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  const originalSetTimeout = globalThis.setTimeout

  let twoN6Lookups = 0
  let aggregateProxyUrl = null
  const aggregateProxyUrls = []
  const itemHash = 'a'.repeat(64)
  const deploymentToken = 'deploy-token-1'
  const walletAddress = '0x1234000000000000000000000000000000000000'

  globalThis.window = {
    ethereum: {
      isMetaMask: true,
      async request(args) {
        if (args.method === 'personal_sign') {
          return '0xsigned'
        }
        throw new Error(`Unexpected provider request: ${args.method}`)
      }
    }
  }

  globalThis.setTimeout = ((callback, _delay, ...args) =>
    originalSetTimeout(callback, 0, ...args))

  globalThis.fetch = async (input, init) => {
    const url = String(input)

    if (url.includes('scheduler.api.aleph.cloud')) {
      return jsonResponse({}, 404)
    }

    if (url.includes('api.2n6.me')) {
      twoN6Lookups += 1
      return jsonResponse({
        url: 'https://relay.example.com',
        active: twoN6Lookups >= 2
      })
    }

    if (url.includes('/v2/about/executions/list')) {
      return jsonResponse({
        [itemHash]: {
          networking: {
            host_ipv4: '203.0.113.7',
            mapped_ports: {
              '80': { host: 30080, tcp: true, udp: false },
              '22': { host: 32022, tcp: true, udp: false },
              '9095': { host: 32095, tcp: true, udp: true },
              '9097': { host: 32097, tcp: true, udp: false },
            }
          }
        }
      })
    }

    if (url.includes('/api/v0/aggregates/') && !init?.method) {
      return jsonResponse({ data: { 'vm-bootstrap-config': {} } })
    }

    if (url.includes('/api/v0/messages') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body ?? '{}'))
      const content = JSON.parse(body.message.item_content)
      if (body.message.type === 'AGGREGATE') {
        aggregateProxyUrl =
          content?.content?.[deploymentToken]?.runtime?.proxyUrl ?? null
        aggregateProxyUrls.push(aggregateProxyUrl)
      }
      return jsonResponse({
        publication_status: { status: 'success' },
        message_status: 'processed'
      })
    }

    if (url.includes('/api/v0/posts.json') && url.includes('vm-bootstrap-config-status')) {
      return jsonResponse({
        posts: [
          {
            content: {
              deploymentToken,
              status: 'applied',
              profile: 'uc-go-peer',
              ownerAddress: walletAddress,
              instanceItemHash: itemHash,
              updatedAt: new Date().toISOString(),
            }
          }
        ]
      })
    }

    if (url.includes('/api/v0/posts.json') && url.includes('relay-bootstrap')) {
      return jsonResponse({
        posts: [
          {
            item_hash: 'bootstrap-item-hash',
            address: walletAddress,
            ref: 'simple-todo-bootstrap',
            type: 'relay-bootstrap',
            content: {
              peerId: '12D3KooWTestPeer',
              multiaddrs: ['/ip4/203.0.113.7/tcp/32095/p2p/12D3KooWTestPeer'],
              browserMultiaddrs: ['/dns4/relay.example.com/tcp/443/tls/ws/p2p/12D3KooWTestPeer'],
              registrationId: 'test-registration-id',
              updatedAt: Date.now(),
            }
          }
        ]
      })
    }

    if (url === 'https://relay.example.com/bootstrap/metadata') {
      return jsonResponse({
        status: 'ready',
        metadata: {
          peer_id: '12D3KooWTestPeer',
          probe_multiaddrs: ['/ip4/203.0.113.7/tcp/32095/p2p/12D3KooWTestPeer'],
          browser_bootstrap_multiaddrs: ['/dns4/relay.example.com/tcp/443/tls/ws/p2p/12D3KooWTestPeer']
        }
      })
    }

    throw new Error(`Unexpected fetch: ${url}`)
  }

  try {
    const controller = createSponsorRelayController({
      apiHost: 'https://api.aleph.im',
      crnListUrl: 'https://crns-list.aleph.sh/crns.json',
      twoN6ApiHost: 'https://api.2n6.me/api/hash',
    })

    controller.patch({
      wallet: {
        connected: true,
        address: walletAddress,
        chainId: '0x1',
        isMetaMask: true,
      },
      manifest: {
        profile: 'uc-go-peer',
        version: 'test-v1',
        rootfsItemHash: 'f'.repeat(64),
        rootfsSizeMiB: 1024,
        createdAt: '2026-06-11T00:00:00.000Z',
      },
      instanceName: 'Test Relay',
      crns: [
        {
          hash: 'crn-1',
          name: 'CRN One',
          address: 'https://crn.example.com',
        }
      ]
    })

    await controller.configureRelayBootstrapRegistration({
      itemHash,
      deploymentToken,
      runtime: {
        allocation: {
          source: 'manual',
          crnHash: 'crn-1',
          crnUrl: 'https://crn.example.com',
          node: { url: 'https://crn.example.com' },
          vmIpv6: null,
          period: null,
        },
        execution: {
          crnUrl: 'https://crn.example.com',
          networking: {
            host_ipv4: '203.0.113.7',
            mapped_ports: {
              '80': { host: 30080, tcp: true, udp: false },
              '22': { host: 32022, tcp: true, udp: false },
              '9095': { host: 32095, tcp: true, udp: true },
              '9097': { host: 32097, tcp: true, udp: false },
            }
          }
        },
        webAccess: {
          url: 'https://relay.example.com',
          active: false,
          subdomain: 'relay.example.com',
        },
        webAccessUrl: 'https://relay.example.com',
        hostIpv4: '203.0.113.7',
        ipv6: null,
        proxyUrl: 'https://relay.example.com',
        mappedPorts: {
          '80': { host: 30080, tcp: true, udp: false },
          '22': { host: 32022, tcp: true, udp: false },
          '9095': { host: 32095, tcp: true, udp: true },
          '9097': { host: 32097, tcp: true, udp: false },
        },
        diagnostics: {
          state: 'ready',
          reason: null,
          schedulerSource: 'manual',
          executionSeen: true,
          webAccessActive: false,
          mappedPortCount: 4,
          proxyUrl: 'https://relay.example.com',
        },
        sshCommand: 'ssh root@203.0.113.7 -p 32022',
        selectedCrn: {
          hash: 'crn-1',
          name: 'CRN One',
          address: 'https://crn.example.com',
        },
        executionLookupBlocked: false,
      }
    })

    assert.ok(twoN6Lookups >= 2)
    assert.deepEqual(aggregateProxyUrls, ['https://relay.example.com', null])
    assert.equal(aggregateProxyUrls[0], 'https://relay.example.com')
  } finally {
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
    globalThis.setTimeout = originalSetTimeout
  }
})

test('controller falls back to bootstrap signal metadata when 2n6 never becomes active', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  const originalSetTimeout = globalThis.setTimeout

  let twoN6Lookups = 0
  const aggregateProxyUrls = []
  const itemHash = 'b'.repeat(64)
  const deploymentToken = 'deploy-token-2'
  const walletAddress = '0x1234000000000000000000000000000000000000'

  globalThis.window = {
    ethereum: {
      isMetaMask: true,
      async request(args) {
        if (args.method === 'personal_sign') {
          return '0xsigned'
        }
        throw new Error(`Unexpected provider request: ${args.method}`)
      }
    }
  }

  globalThis.setTimeout = ((callback, _delay, ...args) =>
    originalSetTimeout(callback, 0, ...args))

  globalThis.fetch = async (input, init) => {
    const url = String(input)

    if (url.includes('scheduler.api.aleph.cloud')) {
      return jsonResponse({}, 404)
    }

    if (url.includes('api.2n6.me')) {
      twoN6Lookups += 1
      return jsonResponse({
        url: 'https://relay.example.com',
        active: false
      })
    }

    if (url.includes('/v2/about/executions/list')) {
      return jsonResponse({
        [itemHash]: {
          networking: {
            host_ipv4: '203.0.113.8',
            mapped_ports: {
              '80': { host: 30080, tcp: true, udp: false },
              '22': { host: 32022, tcp: true, udp: false },
              '9095': { host: 32095, tcp: true, udp: true },
              '9097': { host: 32097, tcp: true, udp: false },
            }
          }
        }
      })
    }

    if (url.includes('/bootstrap/metadata')) {
      throw new Error('Unexpected secure metadata fetch while 2n6 route is inactive')
    }

    if (url.includes('/api/v0/aggregates/') && !init?.method) {
      return jsonResponse({ data: { 'vm-bootstrap-config': {} } })
    }

    if (url.includes('/api/v0/messages') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body ?? '{}'))
      const content = JSON.parse(body.message.item_content)
      if (body.message.type === 'AGGREGATE') {
        aggregateProxyUrls.push(
          content?.content?.[deploymentToken]?.runtime?.proxyUrl ?? null
        )
      }
      return jsonResponse({
        publication_status: { status: 'success' },
        message_status: 'processed'
      })
    }

    if (url.includes('/api/v0/posts.json') && url.includes('vm-bootstrap-config-status')) {
      return jsonResponse({
        posts: [
          {
            content: {
              deploymentToken,
              status: 'applied',
              profile: 'uc-go-peer',
              ownerAddress: walletAddress,
              instanceItemHash: itemHash,
              updatedAt: new Date().toISOString(),
              peerId: '12D3KooWFallbackPeer',
              probeMultiaddrs: ['/ip4/203.0.113.8/tcp/32095/p2p/12D3KooWFallbackPeer'],
              browserBootstrapMultiaddrs: [],
            }
          }
        ]
      })
    }

    if (url.includes('/api/v0/posts.json') && url.includes('relay-bootstrap')) {
      return jsonResponse({
        posts: [
          {
            item_hash: 'bootstrap-item-hash-2',
            address: walletAddress,
            ref: 'simple-todo-bootstrap',
            type: 'relay-bootstrap',
            content: {
              peerId: '12D3KooWFallbackPeer',
              multiaddrs: ['/ip4/203.0.113.8/tcp/32095/p2p/12D3KooWFallbackPeer'],
              browserMultiaddrs: [],
              registrationId: 'relay:uc-go-peer:Fallback Relay:' + itemHash,
              updatedAt: Date.now(),
            }
          }
        ]
      })
    }

    throw new Error(`Unexpected fetch: ${url}`)
  }

  try {
    const controller = createSponsorRelayController({
      apiHost: 'https://api.aleph.im',
      crnListUrl: 'https://crns-list.aleph.sh/crns.json',
      twoN6ApiHost: 'https://api.2n6.me/api/hash',
    })

    controller.patch({
      wallet: {
        connected: true,
        address: walletAddress,
        chainId: '0x1',
        isMetaMask: true,
      },
      manifest: {
        profile: 'uc-go-peer',
        version: 'test-v1',
        rootfsItemHash: 'f'.repeat(64),
        rootfsSizeMiB: 1024,
        createdAt: '2026-06-11T00:00:00.000Z',
      },
      instanceName: 'Fallback Relay',
      crns: [
        {
          hash: 'crn-1',
          name: 'CRN One',
          address: 'https://crn.example.com',
        }
      ]
    })

    await controller.configureRelayBootstrapRegistration({
      itemHash,
      deploymentToken,
      runtime: {
        allocation: {
          source: 'manual',
          crnHash: 'crn-1',
          crnUrl: 'https://crn.example.com',
          node: { url: 'https://crn.example.com' },
          vmIpv6: null,
          period: null,
        },
        execution: {
          crnUrl: 'https://crn.example.com',
          networking: {
            host_ipv4: '203.0.113.8',
            mapped_ports: {
              '80': { host: 30080, tcp: true, udp: false },
              '22': { host: 32022, tcp: true, udp: false },
              '9095': { host: 32095, tcp: true, udp: true },
              '9097': { host: 32097, tcp: true, udp: false },
            }
          }
        },
        webAccess: {
          url: 'https://relay.example.com',
          active: false,
          subdomain: 'relay.example.com',
        },
        webAccessUrl: 'https://relay.example.com',
        hostIpv4: '203.0.113.8',
        ipv6: null,
        proxyUrl: 'https://relay.example.com',
        mappedPorts: {
          '80': { host: 30080, tcp: true, udp: false },
          '22': { host: 32022, tcp: true, udp: false },
          '9095': { host: 32095, tcp: true, udp: true },
          '9097': { host: 32097, tcp: true, udp: false },
        },
        diagnostics: {
          state: 'ready',
          reason: null,
          schedulerSource: 'manual',
          executionSeen: true,
          webAccessActive: false,
          mappedPortCount: 4,
          proxyUrl: 'https://relay.example.com',
        },
        sshCommand: 'ssh root@203.0.113.8 -p 32022',
        selectedCrn: {
          hash: 'crn-1',
          name: 'CRN One',
          address: 'https://crn.example.com',
        },
        executionLookupBlocked: false,
      }
    })

    assert.ok(twoN6Lookups >= 1)
    assert.deepEqual(aggregateProxyUrls, [null, null])
  } finally {
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
    globalThis.setTimeout = originalSetTimeout
  }
})

test('controller configures the ucan-store guest without relay bootstrap publication', async () => {
  const originalFetch = globalThis.fetch
  const seenUrls = []
  const configureBodies = []

  globalThis.fetch = async (input, init) => {
    const url = String(input)
    seenUrls.push(`${init?.method ?? 'GET'} ${url}`)

    if (url.includes('/health')) {
      return jsonResponse({ ok: true })
    }

    if (url.includes('/configure')) {
      configureBodies.push(String(init?.body ?? ''))
      return jsonResponse({ status: 'configured' })
    }

    if (url.includes('/metadata')) {
      return jsonResponse({
        status: 'ready',
        metadata: {
          upload_service_url: 'https://upload.example.com',
          upload_service_did: 'did:web:upload.example.com',
          revocation_url: 'https://upload.example.com/revocations',
          revocation_did: 'did:web:upload.example.com:revocations',
          receipts_url: 'https://upload.example.com/receipts',
          pwa_env: {
            VITE_UPLOAD_SERVICE_URL: 'https://upload.example.com',
            VITE_UPLOAD_SERVICE_DID: 'did:web:upload.example.com',
            VITE_REVOCATION_URL: 'https://upload.example.com/revocations',
            VITE_REVOCATION_DID: 'did:web:upload.example.com:revocations',
            VITE_RECEIPTS_URL: 'https://upload.example.com/receipts',
          },
        },
      })
    }

    throw new Error(`Unexpected fetch: ${url}`)
  }

  try {
    const controller = createSponsorRelayController({
      apiHost: 'https://api.aleph.im',
    })

    controller.patch({
      manifest: {
        profile: 'ucan-store',
        version: 'test-v1',
        rootfsItemHash: 'f'.repeat(64),
        rootfsSizeMiB: 1024,
        createdAt: '2026-06-18T00:00:00.000Z',
      },
    })

    await controller.configureRelayBootstrapRegistration({
      itemHash: 'c'.repeat(64),
      deploymentToken: 'deploy-token-ucan-store',
      runtime: {
        allocation: null,
        execution: null,
        webAccess: null,
        webAccessUrl: 'https://upload.example.com',
        hostIpv4: '203.0.113.17',
        ipv6: '2001:db8::17',
        proxyUrl: 'https://upload.example.com',
        mappedPorts: {
          '80': { host: 30080, tcp: true, udp: false },
          '443': { host: 32443, tcp: true, udp: false },
        },
        diagnostics: {
          state: 'ready',
          reason: null,
          schedulerSource: 'manual',
          executionSeen: true,
          webAccessActive: true,
          mappedPortCount: 2,
          proxyUrl: 'https://upload.example.com',
        },
        sshCommand: null,
        selectedCrn: null,
        executionLookupBlocked: false,
      }
    })

    assert.ok(seenUrls.some((entry) => entry.includes('/health')))
    assert.ok(seenUrls.some((entry) => entry.includes('/configure')))
    assert.ok(seenUrls.some((entry) => entry.includes('/metadata')))
    assert.ok(!seenUrls.some((entry) => entry.includes('relay-bootstrap')))
    assert.ok(!seenUrls.some((entry) => entry.includes('vm-bootstrap-config')))
    assert.equal(configureBodies.length, 1)
    const configurePayload = JSON.parse(configureBodies[0] ?? '{}')
    assert.equal(configurePayload.proxy_url, 'https://upload.example.com')
    assert.equal(configurePayload.webauthn_origin, 'https://upload.example.com')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('controller refresh skips bootstrap registration lookups for ucan-store manifests', async () => {
  const originalFetch = globalThis.fetch
  const seenUrls = []
  const walletAddress = '0x1234000000000000000000000000000000000000'
  const rootfsItemHash = 'd'.repeat(64)

  globalThis.fetch = async (input, init) => {
    const url = String(input)
    seenUrls.push(`${init?.method ?? 'GET'} ${url}`)

    if (url.includes('/api/v0/aggregates/') && url.includes('keys=pricing')) {
      return jsonResponse({
        data: {
          pricing: {
            instance: {
              price: { compute_unit: 1 },
              compute_unit: { vcpus: 1, memory_mib: 1024, disk_mib: 10240 },
              tiers: [{ id: 'tiny', compute_units: 1 }],
            },
          },
        },
      })
    }

    if (url.includes('crns.json')) {
      return jsonResponse({
        crns: [
          {
            hash: 'crn-1',
            name: 'CRN One',
            address: 'https://crn.example.com',
          },
        ],
      })
    }

    if (url.includes(`/api/v0/addresses/${walletAddress}/balance`)) {
      return jsonResponse({
        balance: 100,
        locked_amount: 0,
        credit_balance: 100,
      })
    }

    if (url.includes('/api/v0/messages.json') && url.includes('msgTypes=INSTANCE')) {
      return jsonResponse({ messages: [] })
    }

    if (url.includes(`/api/v0/messages/${rootfsItemHash}`)) {
      return jsonResponse({
        status: 'processed',
        type: 'STORE',
        messages: [
          {
            type: 'STORE',
            content: { item_hash: 'bafytestrootfs' },
          },
        ],
      })
    }

    if (url.includes('/ipfs/bafytestrootfs')) {
      return {
        ok: true,
        status: 200,
        url,
        async json() {
          return {}
        },
      }
    }

    throw new Error(`Unexpected fetch: ${url}`)
  }

  try {
    const controller = createSponsorRelayController({
      apiHost: 'https://api.aleph.im',
      crnListUrl: 'https://crns-list.aleph.sh/crns.json',
    })

    controller.patch({
      wallet: {
        connected: true,
        address: walletAddress,
        chainId: '0x1',
        isMetaMask: true,
      },
      manifestJson: JSON.stringify({
        profile: 'ucan-store',
        version: 'ucan-store-v0.1.0',
        rootfsItemHash,
        rootfsSizeMiB: 20480,
        createdAt: '2026-06-18T00:00:00.000Z',
        requiredPortForwards: [
          { port: 80, tcp: true, udp: false, purpose: 'Temporary setup endpoint' },
          { port: 443, tcp: true, udp: false, purpose: 'HTTPS upload API, did:web discovery, revocation, and receipt proxy' },
        ],
      }),
    })

    await controller.refresh()

    assert.equal(controller.getState().statusText, 'Service deployment data ready')
    assert.equal(
      seenUrls.some((entry) => entry.includes('relay-bootstrap')),
      false,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('controller erases the VM on the CRN before broadcasting FORGET', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window

  const writes = []
  const itemHash = 'c'.repeat(64)
  const walletAddress = '0x1234000000000000000000000000000000000000'

  globalThis.window = {
    ethereum: {
      isMetaMask: true,
      async request(args) {
        if (args.method === 'personal_sign') {
          return '0xsigned'
        }
        throw new Error(`Unexpected provider request: ${args.method}`)
      }
    }
  }

  globalThis.fetch = async (input, init) => {
    const url = String(input)

    if (url === `https://crn.example.com/control/machine/${itemHash}/erase`) {
      writes.push({ type: 'erase', url, init })
      return jsonResponse({})
    }

    if (url.includes('/api/v0/messages') && init?.method === 'POST') {
      writes.push({ type: 'forget', url, init })
      return jsonResponse({
        publication_status: { status: 'success' },
        message_status: 'processed'
      })
    }

    throw new Error(`Unexpected fetch: ${url}`)
  }

  try {
    const controller = createSponsorRelayController({
      apiHost: 'https://api.aleph.im',
      schedulerApiHost: 'https://scheduler.api.aleph.cloud',
    })

    controller.refresh = async () => {}
    controller.patch({
      wallet: {
        connected: true,
        address: walletAddress,
        chainId: '0x1',
        isMetaMask: true,
      },
      instances: [
        {
          instance: {
            item_hash: itemHash,
            status: 'processed',
            confirmed: true,
            content: {
              requirements: {
                node: {
                  node_hash: 'crn-1',
                },
              },
            },
          },
          details: {
            messageStatus: 'processed',
            allocationSource: 'manual',
            crnUrl: 'https://crn.example.com',
            hostIpv4: null,
            ipv6: null,
            vmIpv4: null,
            webUrl: null,
            sshCommand: null,
            mappedPorts: [],
            execution: null,
            error: null,
          },
        },
      ],
      bootstrapRegistrations: [
        {
          messageHash: 'registration-hash',
          hash: 'registration-hash',
          itemHash: 'registration-hash',
          address: walletAddress,
          time: Date.now(),
          instanceItemHash: itemHash,
          confirmed: true,
          content: null,
        },
      ],
    })

    await controller.deleteInstance(itemHash)

    assert.equal(writes.length, 2)
    assert.equal(writes[0].type, 'erase')
    assert.equal(writes[1].type, 'forget')

    const forgetPayload = JSON.parse(String(writes[1].init.body))
    const forgetContent = JSON.parse(forgetPayload.message.item_content)
    assert.deepEqual(forgetContent.hashes, [itemHash, 'registration-hash'])
  } finally {
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
  }
})
