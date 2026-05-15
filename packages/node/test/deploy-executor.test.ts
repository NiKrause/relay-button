import test from 'node:test'
import assert from 'node:assert/strict'

import { executeDeployPlan } from '../src/deploy-executor.ts'
import type { DeployPlan } from '../src/deploy-plan.ts'

const DEPLOY_PLAN: DeployPlan = {
  profile: 'uc-go-peer',
  privateKey: '0xabc',
  apiHost: 'https://api2.aleph.im',
  crnListUrl: 'https://crns-list.aleph.sh/crns.json',
  name: 'uc-go-peer',
  sshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest key@example',
  rootfsItemHash: 'a'.repeat(64),
  rootfsVersion: '2026.05.14',
  rootfsSizeMiB: 20480,
  crnHash: 'crn-1',
  preferredCountryCode: 'DE',
  geoCrnLimit: 30,
  maxCrnAttempts: 2,
  vcpus: 1,
  memoryMiB: 1024,
  seconds: 30,
  channel: 'TEST',
  waitAttempts: 2,
  waitDelayMs: 1,
  runtimeAttempts: 2,
  runtimeDelayMs: 1,
  setupAttempts: 2,
  setupDelayMs: 1,
  verifyAttempts: 2,
  verifyDelayMs: 1,
  tcpTimeoutMs: 100,
  httpTimeoutMs: 100,
  metadataAttempts: 2,
  metadataDelayMs: 1,
  metadataTimeoutMs: 100,
  configureTimeoutMs: 100,
  enableCaddyProxy: true,
  autoConfigure: true,
  verifyReachability: true,
  requiredPorts: [{ port: 22, tcp: true, udp: false, purpose: 'SSH' }],
  publishPortForwards: true
}

function jsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload
    }
  }
}

test('executeDeployPlan deploys, publishes port forwards, and waits for processing', async () => {
  const calls: string[] = []
  const result = await executeDeployPlan(DEPLOY_PLAN, {
    sender: '0x1234',
    signer: async () => '0xsigned',
    hasher: (() => {
      let count = 0
      return () => `hash-${++count}`
    })(),
    sleep: async () => undefined,
    tcpProbe: async () => ({ ok: true }),
    fetch: async (url, init) => {
      calls.push(`${String(init?.method ?? 'GET')} ${url}`)

      if (String(url).includes('crns-list.aleph.sh')) {
        return jsonResponse({
          crns: [{ hash: 'crn-1', name: 'CRN One', address: 'https://crn.example.com', score: 10, country_code: 'DE' }]
        })
      }

      if (String(url).includes('/api/v0/aggregates/0x1234.json')) {
        return jsonResponse({})
      }

      if (String(url).includes('/api/v0/messages/hash-1') && !init?.method) {
        return jsonResponse({ status: 'processed', details: { rootfs: DEPLOY_PLAN.rootfsItemHash } })
      }

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
        return jsonResponse({
          'hash-1': {
            networking: {
              host_ipv4: '203.0.113.7',
              mapped_ports: {
                '80': { host: 30080, tcp: true, udp: false },
                '22': { host: 32022, tcp: true, udp: false },
                '9095': { host: 32095, tcp: true, udp: true },
                '9097': { host: 32097, tcp: true, udp: false }
              }
            }
          }
        })
      }

      if (String(url).includes('/health')) {
        return jsonResponse({ ok: true })
      }

      if (String(url).includes('/configure')) {
        return jsonResponse({ status: 'configured' })
      }

      if (String(url).includes('/metadata')) {
        return jsonResponse({
          status: 'ready',
          metadata: {
            peer_id: '12D3KooW...',
            probe_multiaddrs: ['/ip4/203.0.113.7/tcp/32095/p2p/12D3KooW...'],
            browser_bootstrap_multiaddrs: ['/dns4/relay.example.com/tcp/443/tls/ws/p2p/12D3KooW...']
          }
        })
      }

      if (String(url).includes('/control/allocation/notify')) {
        return jsonResponse({ ok: true })
      }

      if (String(url).includes('/api/v0/messages/') && !init?.method) {
        return jsonResponse({ status: 'processed', message: { type: 'STORE' } })
      }

      return jsonResponse(
        {
          publication_status: { status: 'success' },
          message_status: 'pending'
        },
        202
      )
    }
  })

  assert.equal(result.sender, '0x1234')
  assert.equal(result.itemHash, 'hash-1')
  assert.equal(result.status, 'processed')
  assert.equal(result.portForwarding?.aggregateItemHash, 'hash-2')
  assert.equal(result.verification?.ok, true)
  assert.match(result.runtime?.diagnostics?.state ?? '', /ready/)
  assert.equal(result.runtime?.hostIpv4, '203.0.113.7')
  assert.equal(result.runtime?.sshCommand, 'ssh root@203.0.113.7 -p 32022')
  assert.equal(result.runtime?.setupHealth?.ok, true)
  assert.equal(result.configuration?.metadata?.peer_id, '12D3KooW...')
  assert.ok(calls.some((entry) => entry.includes('/api/v0/aggregates/0x1234.json')))
})

test('executeDeployPlan retries on a rejected first CRN and succeeds on the next candidate', async () => {
  let messageCount = 0
  const result = await executeDeployPlan(
    {
      ...DEPLOY_PLAN,
      crnHash: '',
      publishPortForwards: false,
      autoConfigure: false,
      verifyReachability: false
    },
    {
      sender: '0x1234',
      signer: async () => '0xsigned',
      hasher: (() => {
        let count = 0
        return () => `hash-r${++count}`
      })(),
      sleep: async () => undefined,
      tcpProbe: async () => ({ ok: true }),
      fetch: async (url, init) => {
        if (String(url).includes('crns-list.aleph.sh')) {
          return jsonResponse({
            crns: [
              { hash: 'crn-a', name: 'CRN A', address: 'https://crn-a.example.com', score: 10, country_code: 'DE' },
              { hash: 'crn-b', name: 'CRN B', address: 'https://crn-b.example.com', score: 9, country_code: 'DE' }
            ]
          })
        }

        if (String(url).includes('/api/v0/messages') && init?.method === 'POST') {
          messageCount += 1
          return jsonResponse({ message_status: 'pending' }, 202)
        }

        if (String(url).includes('/api/v0/messages/hash-r1') && !init?.method) {
          return jsonResponse({ status: 'rejected', error_code: 42, details: {} })
        }

        if (String(url).includes('/api/v0/messages/hash-r2') && !init?.method) {
          return jsonResponse({ status: 'processed', details: {} })
        }

        if (String(url).includes('scheduler.api.aleph.cloud')) {
          return jsonResponse({
            node: {
              node_id: 'crn-b',
              url: 'https://crn-b.example.com'
            }
          })
        }

        if (String(url).includes('api.2n6.me')) {
          return jsonResponse({ url: 'https://relay.example.com', active: true })
        }

        if (String(url).includes('/v2/about/executions/list')) {
          return jsonResponse({
            'hash-r2': {
              networking: {
                host_ipv4: '203.0.113.21',
                mapped_ports: {
                  '22': { host: 32222, tcp: true, udp: false }
                }
              }
            }
          })
        }

        return jsonResponse({ status: 'processed', message: { type: 'STORE' } })
      }
    }
  )

  assert.equal(result.itemHash, 'hash-r2')
  assert.equal(result.selectedCrn?.hash, 'crn-b')
  assert.equal(messageCount, 2)
})
