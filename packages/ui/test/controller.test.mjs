import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createSponsorRelayController,
} from '../dist/shared/index.js'

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
      apiHost: 'https://api2.aleph.im',
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
