import test from 'node:test'
import assert from 'node:assert/strict'

import { executeDeployPlan } from '../src/deploy-executor.ts'
import { deriveBootstrapPublisherPrivateKey } from '../src/bootstrap-publisher.ts'
import type { DeployPlan } from '../src/deploy-plan.ts'
import { deriveLibp2pSecp256k1IdentityFromEvmKey } from '../src/relay-identity.ts'
import { createPrivateKeyIdentity } from '../src/signer.ts'

const DEPLOY_PLAN: DeployPlan = {
  profile: 'uc-go-peer',
  privateKey: '0x0123456789012345678901234567890123456789012345678901234567890123',
  bootstrapPublisherPrivateKey: '',
  bootstrapOwnerPrivateKey: '',
  apiHost: 'https://api.aleph.im',
  crnListUrl: 'https://crns-list.aleph.sh/crns.json',
  name: 'uc-go-peer',
  sshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest key@example',
  rootfsItemHash: 'a'.repeat(64),
  rootfsVersion: '2026.05.14',
  rootfsSizeMiB: 20480,
  placementStrategy: 'manual',
  crnHash: 'crn-1',
  preferredCountryCode: 'DE',
  geoCrnLimit: 30,
  maxCrnAttempts: 2,
  vcpus: 1,
  memoryMiB: 1024,
  seconds: 30,
  channel: 'TEST',
  instanceCustomDomain: '',
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
  preserveFailedDeployment: false,
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
  const configureBodies: string[] = []
  const bootstrapPublisherPrivateKey =
    '0x59c6995e998f97a5a0044966f0945382d7d5d95f993dbf3b61e64d1d4438f3f0'
  const bootstrapOwnerPrivateKey =
    '0x8b3a350cf5c34c9194ca3a545d5487d74f7382a1d9dfc021f7b64fc6d98f6c1d'
  const expectedRelayIdentity = deriveLibp2pSecp256k1IdentityFromEvmKey(
    bootstrapPublisherPrivateKey
  )
  const result = await executeDeployPlan({
    ...DEPLOY_PLAN,
    bootstrapPublisherPrivateKey,
    bootstrapOwnerPrivateKey
  }, {
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
                ipv6_ip: '2001:db8::7',
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
        configureBodies.push(String(init?.body ?? ''))
        return jsonResponse({ status: 'configured' })
      }

      if (String(url).includes('/metadata')) {
        return jsonResponse({
          status: 'ready',
          metadata: {
            peer_id: expectedRelayIdentity.peerId,
            probe_multiaddrs: [`/ip4/203.0.113.7/tcp/32095/p2p/${expectedRelayIdentity.peerId}`],
            browser_bootstrap_multiaddrs: [`/dns4/relay.example.com/tcp/443/tls/ws/p2p/${expectedRelayIdentity.peerId}`]
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
  assert.equal(result.configuration?.metadata?.peer_id, expectedRelayIdentity.peerId)
  // No key material may reach the guest setup endpoint — it is plain HTTP.
  // The authorization is no longer precomputed (it commits to the guest's
  // real peerId), so it follows only once the registration is published.
  assert.ok(configureBodies.length >= 1)
  for (const body of configureBodies) {
    const payload = JSON.parse(body || '{}')
    assert.equal(payload.bootstrap_publisher_private_key, undefined)
    assert.equal(payload.bootstrap_publisher_libp2p_identity_b64, undefined)
    assert.equal(payload.bootstrap_owner_private_key, undefined)
  }
  assert.ok(calls.some((entry) => entry.includes('/api/v0/aggregates/0x1234.json')))
  const notifyIndex = calls.findIndex((entry) => entry.includes('/control/allocation/notify'))
  const runtimeIndex = calls.findIndex((entry) => entry.includes('/v2/about/executions/list'))
  assert.notEqual(notifyIndex, -1)
  assert.notEqual(runtimeIndex, -1)
  assert.ok(notifyIndex < runtimeIndex)
})

test('executeDeployPlan uses scheduler placement without pinning a CRN by default', async () => {
  const calls: string[] = []
  let instanceContent: Record<string, unknown> | null = null

  const result = await executeDeployPlan(
    {
      ...DEPLOY_PLAN,
      placementStrategy: 'scheduler',
      crnHash: '',
      publishPortForwards: false,
      enableCaddyProxy: false,
      autoConfigure: false,
      verifyReachability: false
    },
    {
      sender: '0x1234',
      signer: async () => '0xsigned',
      hasher: (() => {
        let count = 0
        return () => `hash-scheduler-${++count}`
      })(),
      sleep: async () => undefined,
      tcpProbe: async () => ({ ok: true }),
      fetch: async (url, init) => {
        calls.push(`${String(init?.method ?? 'GET')} ${url}`)

        if (String(url).includes('crns-list.aleph.sh')) {
          throw new Error('scheduler placement should not preselect from the CRN list')
        }

        if (String(url).includes('/api/v0/addresses/0x1234/balance')) {
          return jsonResponse({})
        }

        if (String(url).endsWith('/api/v0/messages') && init?.method === 'POST') {
          const payload = JSON.parse(String(init.body)) as {
            message?: { type?: string; item_content?: string }
          }
          if (payload.message?.type === 'INSTANCE') {
            instanceContent = JSON.parse(payload.message.item_content ?? '{}')
          }
          return jsonResponse({
            publication_status: { status: 'success' },
            message_status: 'pending'
          }, 202)
        }

        if (String(url).includes('/api/v0/messages/hash-scheduler-1') && !init?.method) {
          return jsonResponse({ status: 'processed', details: { rootfs: DEPLOY_PLAN.rootfsItemHash } })
        }

        if (String(url).includes('scheduler.api.aleph.cloud')) {
          return jsonResponse({
            node: {
              node_id: 'scheduler-crn',
              url: 'https://scheduler-crn.example.com'
            }
          })
        }

        if (String(url).includes('api.2n6.me')) {
          return jsonResponse({ active: false })
        }

        if (String(url).includes('/v2/about/executions/list')) {
          return jsonResponse({
            'hash-scheduler-1': {
              networking: {
                host_ipv4: '203.0.113.8',
                mapped_ports: {
                  '22': { host: 32022, tcp: true, udp: false }
                }
              }
            }
          })
        }

        return jsonResponse({})
      }
    }
  )

  assert.equal(result.itemHash, 'hash-scheduler-1')
  assert.equal(result.runtime?.allocation?.source, 'scheduler')
  assert.equal(result.runtime?.selectedCrn?.hash, 'scheduler-crn')
  assert.equal(instanceContent?.requirements, undefined)
  assert.ok(!calls.some((entry) => entry.includes('crns-list.aleph.sh')))
})

test('executeDeployPlan rebroadcasts when Aleph rejects scheduler placement before the rootfs STORE is visible', async () => {
  let messageCount = 0
  let sleepCount = 0
  const logs: string[] = []

  const result = await executeDeployPlan(
    {
      ...DEPLOY_PLAN,
      placementStrategy: 'scheduler',
      crnHash: '',
      maxCrnAttempts: 3,
      publishPortForwards: false,
      enableCaddyProxy: false,
      autoConfigure: false,
      verifyReachability: false
    },
    {
      sender: '0x1234',
      log: (message) => {
        logs.push(message)
      },
      signer: async () => '0xsigned',
      hasher: (() => {
        let count = 0
        return () => `hash-race-${++count}`
      })(),
      sleep: async () => {
        sleepCount += 1
      },
      tcpProbe: async () => ({ ok: true }),
      fetch: async (url, init) => {
        if (String(url).includes('crns-list.aleph.sh')) {
          throw new Error('scheduler placement should not preselect from the CRN list')
        }

        if (String(url).includes('/api/v0/addresses/0x1234/balance')) {
          return jsonResponse({})
        }

        if (String(url).endsWith('/api/v0/messages') && init?.method === 'POST') {
          messageCount += 1
          return jsonResponse({
            publication_status: { status: 'success' },
            message_status: 'pending'
          }, 202)
        }

        if (String(url).includes('/api/v0/messages/hash-race-1') && !init?.method) {
          return jsonResponse({
            status: 'rejected',
            error_code: 301,
            details: {
              errors: [DEPLOY_PLAN.rootfsItemHash]
            }
          })
        }

        if (String(url).includes(`/api/v0/messages/${DEPLOY_PLAN.rootfsItemHash}`) && !init?.method) {
          return jsonResponse({
            status: 'processed',
            type: 'STORE'
          })
        }

        if (String(url).includes('/api/v0/messages/hash-race-2') && !init?.method) {
          return jsonResponse({ status: 'processed', details: { rootfs: DEPLOY_PLAN.rootfsItemHash } })
        }

        if (String(url).includes('scheduler.api.aleph.cloud')) {
          return jsonResponse({
            node: {
              node_id: 'scheduler-crn',
              url: 'https://scheduler-crn.example.com'
            }
          })
        }

        if (String(url).includes('api.2n6.me')) {
          return jsonResponse({ active: false })
        }

        if (String(url).includes('/v2/about/executions/list')) {
          return jsonResponse({
            'hash-race-2': {
              networking: {
                host_ipv4: '203.0.113.8',
                mapped_ports: {
                  '22': { host: 32022, tcp: true, udp: false }
                }
              }
            }
          })
        }

        return jsonResponse({})
      }
    }
  )

  assert.equal(result.itemHash, 'hash-race-2')
  assert.equal(messageCount, 2)
  assert.equal(sleepCount, 1)
  assert.ok(logs.some((entry) => entry.includes('rootfs STORE is not visible to the VM processor yet')))
})

test('executeDeployPlan configures ucan-store guests without relay bootstrap publication', async () => {
  const calls: string[] = []
  const configureBodies: string[] = []
  const postedMessages: string[] = []
  const events: string[] = []
  let sleepCount = 0
  let customDomainAttempts = 0

  const result = await executeDeployPlan(
    {
      ...DEPLOY_PLAN,
      profile: 'ucan-store',
      name: 'ucan-store',
      adminDid: 'did:key:z6Mkadmin123',
      ucanStoreBootstrapPackage: {
        operatorAddress: '0x1234000000000000000000000000000000000000',
        adminDid: 'did:key:z6Mkadmin123',
        serviceDid: 'did:key:z6Mkservice123',
        spaceDid: 'did:key:z6Mkspace123',
        rootDelegationProof: 'uEgVjYW5wcm9vZg',
        allowedCapabilities: ['space/blob/add', 'space/blob/list'],
        defaultUserDelegationExpiration: 86400,
        maxUserDelegationExpiration: 604800,
        pwaOrigin: 'https://store.example.com',
        serviceOrigin: 'https://upload.example.com',
      },
      instanceCustomDomain: 'https://upload.example.com',
      publishPortForwards: false,
      verifyReachability: true
    },
    {
      sender: '0x1234',
      signer: async () => '0xsigned',
      hasher: (() => {
        let count = 0
        return () => `hash-s${++count}`
      })(),
      sleep: async () => {
        sleepCount += 1
      },
      tcpProbe: async () => ({ ok: true }),
      fetch: async (url, init) => {
        calls.push(`${String(init?.method ?? 'GET')} ${url}`)

        if (String(url).includes('crns-list.aleph.sh')) {
          return jsonResponse({
            crns: [{ hash: 'crn-1', name: 'CRN One', address: 'https://crn.example.com', score: 10, country_code: 'DE' }]
          })
        }

        if (String(url).includes('/api/v0/messages/hash-s1') && !init?.method) {
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
            url: 'https://reserved-proxy.example.2n6.me',
            active: false
          })
        }

        if (String(url).includes('/v2/about/executions/list')) {
          return jsonResponse({
            'hash-s1': {
              networking: {
                host_ipv4: '203.0.113.17',
                ipv6_ip: '2001:db8::17',
                mapped_ports: {
                  '80': { host: 30080, tcp: true, udp: false },
                  '22': { host: 32022, tcp: true, udp: false },
                  '443': { host: 32443, tcp: true, udp: false }
                }
              }
            }
          })
        }

        if (String(url).includes('/health')) {
          return jsonResponse({ ok: true })
        }

        if (String(url).includes('/configure')) {
          events.push('configure')
          configureBodies.push(String(init?.body ?? ''))
          return jsonResponse({ status: 'configured' })
        }

        if (String(url).includes('/metadata')) {
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
                VITE_RECEIPTS_URL: 'https://upload.example.com/receipts'
              }
            }
          })
        }

        if (String(url).includes('/control/allocation/notify')) {
          return jsonResponse({ ok: true })
        }

        if (String(url) === 'https://upload.example.com/.well-known/ucan-store.json') {
          customDomainAttempts += 1
          if (customDomainAttempts < 4) {
            return jsonResponse({ status: 'warming' }, 503)
          }
          return jsonResponse({ status: 'ok' })
        }

        if (String(url).includes('/api/v0/messages/') && !init?.method) {
          return jsonResponse({ status: 'processed', message: { type: 'STORE' } })
        }

        if (String(url).endsWith('/api/v0/messages') && init?.method === 'POST') {
          const body = String(init.body ?? '')
          postedMessages.push(body)
          try {
            const parsed = JSON.parse(body) as { message?: { type?: string; item_content?: string } }
            if (parsed.message?.type === 'AGGREGATE') {
              const itemContent = JSON.parse(parsed.message.item_content ?? '{}') as {
                content?: Record<string, unknown>
              }
              if (itemContent.content?.['upload.example.com']) {
                events.push('domain-aggregate')
              }
            }
          } catch {
            // Keep the test focused on deployment sequencing.
          }
          return jsonResponse(
            {
              publication_status: { status: 'success' },
              message_status: 'pending'
            },
            202
          )
        }

        return jsonResponse(
          {
            publication_status: { status: 'success' },
            message_status: 'pending'
          },
          202
        )
      }
    }
  )

  assert.equal(result.itemHash, 'hash-s1')
  assert.equal(result.runtime?.hostIpv4, '203.0.113.17')
  assert.equal(result.runtime?.setupHealth?.ok, true)
  assert.equal(result.verification?.ok, true)
  assert.equal(result.instanceDomain?.domain, 'upload.example.com')
  assert.equal(result.instanceDomain?.url, 'https://upload.example.com')
  assert.equal(result.instanceDomain?.itemHash, 'hash-s1')
  assert.equal(result.instanceDomain?.aggregateItemHash, 'hash-s2')
  assert.equal(result.instanceDomain?.aggregateStatus, 'pending')
  assert.equal(
    result.configuration?.metadata?.upload_service_url,
    'https://upload.example.com'
  )
  assert.equal(
    result.configuration?.metadata?.upload_service_did,
    'did:web:upload.example.com'
  )
  assert.equal(configureBodies.length, 1)
  const configurePayload = JSON.parse(configureBodies[0] ?? '{}')
  assert.equal(configurePayload.proxy_url, 'https://reserved-proxy.example.2n6.me')
  assert.equal(configurePayload.webauthn_origin, 'https://upload.example.com')
  assert.equal(configurePayload.service_did, 'did:key:z6Mkservice123')
  assert.equal(configurePayload.service_origin, 'https://upload.example.com')
  assert.equal(configurePayload.public_storage_origin, 'https://upload.example.com')
  assert.equal(configurePayload.admin_did, 'did:key:z6Mkadmin123')
  assert.equal(
    configurePayload.bootstrap_package.serviceDid,
    'did:key:z6Mkservice123'
  )
  assert.equal(
    configurePayload.bootstrap_package.serviceOrigin,
    'https://upload.example.com'
  )
  assert.ok(calls.some((entry) => entry.includes('/health')))
  assert.ok(calls.some((entry) => entry.includes('/configure')))
  assert.ok(calls.some((entry) => entry.includes('/metadata')))
  assert.ok(calls.some((entry) => entry === 'GET https://upload.example.com/.well-known/ucan-store.json'))
  assert.ok(!calls.some((entry) => entry.includes('relay-bootstrap')))
  assert.equal(customDomainAttempts, 4)
  assert.equal(sleepCount, 3)
  assert.ok(
    events.indexOf('domain-aggregate') >= 0 &&
      events.indexOf('domain-aggregate') < events.indexOf('configure')
  )
  assert.deepEqual(
    result.verification?.checks?.['https:instance-custom-domain'],
    {
      ok: true,
      url: 'https://upload.example.com/.well-known/ucan-store.json',
      status: 200,
      error: undefined
    }
  )

  const domainAggregate = postedMessages
    .map((body) => JSON.parse(body) as { message?: { type?: string; item_content?: string } })
    .find((body) => {
      if (body.message?.type !== 'AGGREGATE') return false
      const itemContent = JSON.parse(body.message.item_content ?? '{}') as {
        content?: Record<string, unknown>
      }
      return Boolean(itemContent.content?.['upload.example.com'])
    })
  assert.ok(domainAggregate)
  const domainContent = JSON.parse(
    domainAggregate.message?.item_content ?? '{}'
  ) as {
    content?: Record<string, Record<string, unknown>>
  }
  assert.deepEqual(
    {
      message_id: domainContent.content?.['upload.example.com']?.message_id,
      type: domainContent.content?.['upload.example.com']?.type,
      programType: domainContent.content?.['upload.example.com']?.programType,
    },
    {
      message_id: 'hash-s1',
      type: 'instance',
      programType: 'instance',
    }
  )
  assert.equal(typeof domainContent.content?.['upload.example.com']?.updated_at, 'number')
})

test('executeDeployPlan configures ucan-store Caddy before reserved proxy activation', async () => {
  const configureBodies: string[] = []
  const logs: string[] = []
  let sleepCount = 0
  let twoN6Lookups = 0

  const result = await executeDeployPlan(
    {
      ...DEPLOY_PLAN,
      profile: 'ucan-store',
      name: 'ucan-store',
      adminDid: 'did:key:z6Mkadmin123',
      ucanStoreBootstrapPackage: {
        operatorAddress: '0x1234000000000000000000000000000000000000',
        adminDid: 'did:key:z6Mkadmin123',
        serviceDid: 'did:key:z6Mkservice123',
        spaceDid: 'did:key:z6Mkspace123',
        rootDelegationProof: 'uEgVjYW5wcm9vZg',
        allowedCapabilities: ['space/blob/add', 'space/blob/list'],
        defaultUserDelegationExpiration: 86400,
        maxUserDelegationExpiration: 604800,
        pwaOrigin: 'https://store.example.com',
        serviceOrigin: '',
      },
      publishPortForwards: false,
      verifyReachability: false
    },
    {
      sender: '0x1234',
      log: (message) => {
        logs.push(message)
      },
      signer: async () => '0xsigned',
      hasher: (() => {
        let count = 0
        return () => `hash-u${++count}`
      })(),
      sleep: async () => {
        sleepCount += 1
      },
      tcpProbe: async () => ({ ok: true }),
      fetch: async (url, init) => {
        if (String(url).includes('crns-list.aleph.sh')) {
          return jsonResponse({
            crns: [{ hash: 'crn-1', name: 'CRN One', address: 'https://crn.example.com', score: 10, country_code: 'DE' }]
          })
        }

        if (String(url).includes('/api/v0/messages/hash-u1') && !init?.method) {
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
          twoN6Lookups += 1
          return jsonResponse({
            url: 'https://reserved-proxy.example.2n6.me',
            active: false
          })
        }

        if (String(url).includes('/v2/about/executions/list')) {
          return jsonResponse({
            'hash-u1': {
              networking: {
                host_ipv4: '203.0.113.27',
                ipv6_ip: '2001:db8::27',
                mapped_ports: {
                  '80': { host: 30080, tcp: true, udp: false },
                  '22': { host: 32022, tcp: true, udp: false },
                  '443': { host: 32443, tcp: true, udp: false }
                }
              }
            }
          })
        }

        if (String(url).includes('/health')) {
          return jsonResponse({ ok: true })
        }

        if (String(url).includes('/configure')) {
          configureBodies.push(String(init?.body ?? ''))
          return jsonResponse({ status: 'configured' })
        }

        if (String(url).includes('/metadata')) {
          return jsonResponse({
            status: 'ready',
            metadata: {
              upload_service_url: 'https://reserved-proxy.example.2n6.me',
              upload_service_did: 'did:web:reserved-proxy.example.2n6.me',
              pwa_env: {
                VITE_UPLOAD_SERVICE_URL: 'https://reserved-proxy.example.2n6.me'
              }
            }
          })
        }

        if (String(url).includes('/control/allocation/notify')) {
          return jsonResponse({ ok: true })
        }

        return jsonResponse(
          {
            publication_status: { status: 'success' },
            message_status: 'pending'
          },
          202
        )
      }
    }
  )

  assert.equal(result.itemHash, 'hash-u1')
  assert.equal(configureBodies.length, 1)
  assert.equal(twoN6Lookups, 1)
  assert.equal(sleepCount, 0)
  assert.ok(!logs.some((entry) => entry.includes('waiting before guest configure')))
  assert.equal(
    JSON.parse(configureBodies[0] ?? '{}').proxy_url,
    'https://reserved-proxy.example.2n6.me'
  )
})

test('executeDeployPlan retries on a rejected first CRN and succeeds on the next candidate', async () => {
  let messageCount = 0
  const logs: string[] = []
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
      log: (message) => {
        logs.push(message)
      },
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

        if (String(url).includes('/api/v0/addresses/0x1234/balance')) {
          return jsonResponse({
            balance: '12.5',
            credit_balance: 7.25,
            locked_amount: '1.5'
          })
        }

        if (String(url).includes('/api/v0/messages') && init?.method === 'POST') {
          messageCount += 1
          return jsonResponse({ message_status: 'pending' }, 202)
        }

        if (String(url).includes('/api/v0/messages/hash-r1') && !init?.method) {
          return jsonResponse({
            status: 'rejected',
            error_code: 42,
            details: {
              errors: [
                {
                  account_balance: 0,
                  required_balance: 14250
                }
              ]
            }
          })
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
                ipv6_ip: '2001:db8::21',
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
  assert.ok(logs.some((entry) => entry.includes('preflight balance for 0x1234: balance=12.5 credit_balance=7.25 locked_amount=1.5')))
  assert.ok(logs.some((entry) => entry.includes('raw rejection details for hash-r1')))
  assert.ok(logs.some((entry) => entry.includes('insufficient Aleph balance')))
})

test('executeDeployPlan retries on the next CRN when a processed deployment never exposes runtime networking', async () => {
  const postedBodies: string[] = []

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
        return () => `hash-p${++count}`
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
          postedBodies.push(String(init.body ?? ''))
          return jsonResponse({ message_status: 'pending' }, 202)
        }

        if (String(url).includes('/api/v0/messages/hash-p1') && !init?.method) {
          return jsonResponse({ status: 'processed', details: {} })
        }

        if (String(url).includes('/api/v0/messages/hash-p3') && !init?.method) {
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
          if (String(url).includes('hash-p1')) {
            return jsonResponse({
              'hash-p1': {
                networking: {
                  host_ipv4: null,
                  mapped_ports: {}
                }
              }
            })
          }

          return jsonResponse({
            'hash-p3': {
              networking: {
                host_ipv4: '203.0.113.21',
                ipv6_ip: '2001:db8::121',
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

  assert.equal(result.itemHash, 'hash-p3')
  assert.equal(result.selectedCrn?.hash, 'crn-b')
  assert.equal(result.runtime?.hostIpv4, '203.0.113.21')

  const forgetBodies = postedBodies.filter((body) => body.includes('"type":"FORGET"'))
  assert.equal(forgetBodies.length, 1)
  assert.match(forgetBodies[0], /hash-p1/)

  const instanceBodies = postedBodies.filter((body) => body.includes('"type":"INSTANCE"'))
  assert.equal(instanceBodies.length, 2)
})

test('executeDeployPlan can preserve a failed deployment for debugging', async () => {
  const postedBodies: string[] = []
  const logs: string[] = []

  await assert.rejects(
    executeDeployPlan(
      {
        ...DEPLOY_PLAN,
        crnHash: '',
        maxCrnAttempts: 1,
        publishPortForwards: false,
        autoConfigure: false,
        verifyReachability: false,
        preserveFailedDeployment: true
      },
      {
        sender: '0x1234',
        signer: async () => '0xsigned',
        hasher: (() => {
          let count = 0
          return () => `hash-debug-${++count}`
        })(),
        sleep: async () => undefined,
        log: (message) => logs.push(message),
        tcpProbe: async () => ({ ok: true }),
        fetch: async (url, init) => {
          if (String(url).includes('crns-list.aleph.sh')) {
            return jsonResponse({
              crns: [
                { hash: 'crn-a', name: 'CRN A', address: 'https://crn-a.example.com', score: 10, country_code: 'DE' }
              ]
            })
          }

          if (String(url).includes('/api/v0/messages') && init?.method === 'POST') {
            postedBodies.push(String(init.body ?? ''))
            return jsonResponse({ message_status: 'pending' }, 202)
          }

          if (String(url).includes('/api/v0/messages/hash-debug-1') && !init?.method) {
            return jsonResponse({ status: 'processed', details: {} })
          }

          if (String(url).includes('/v2/about/executions/list')) {
            return jsonResponse({
              'hash-debug-1': {
                networking: {
                  host_ipv4: null,
                  mapped_ports: {}
                }
              }
            })
          }

          return jsonResponse({ status: 'processed', message: { type: 'STORE' } })
        }
      }
    ),
    /did not expose runtime networking/
  )

  const forgetBodies = postedBodies.filter((body) => body.includes('"type":"FORGET"'))
  assert.equal(forgetBodies.length, 0)
  assert.ok(logs.some((entry) => entry.includes('preserving failed deployment hash-debug-1 for debugging')))
})

test('executeDeployPlan retries on the next CRN when a proxy-backed deployment exposes only ULA guest IPv6', async () => {
  const postedBodies: string[] = []

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
        return () => `hash-u${++count}`
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
          postedBodies.push(String(init.body ?? ''))
          return jsonResponse({ message_status: 'pending' }, 202)
        }

        if (String(url).includes('scheduler.api.aleph.cloud')) {
          return jsonResponse({ error: 'VM is not allocated to any node' }, 404)
        }

        if (String(url).includes('api.2n6.me')) {
          return jsonResponse({ url: 'https://relay.example.com', active: true })
        }

        if (String(url).includes('/api/v0/messages/hash-u1') && !init?.method) {
          return jsonResponse({ status: 'processed', details: {} })
        }

        if (String(url).includes('/api/v0/messages/hash-u3') && !init?.method) {
          return jsonResponse({ status: 'processed', details: {} })
        }

        if (String(url).includes('https://crn-a.example.com/v2/about/executions/list')) {
          return jsonResponse({
            'hash-u1': {
              networking: {
                host_ipv4: '203.0.113.31',
                ipv6_ip: 'fc00:1:2:3::31',
                mapped_ports: {
                  '22': { host: 32231, tcp: true, udp: false }
                }
              }
            }
          })
        }

        if (String(url).includes('https://crn-b.example.com/v2/about/executions/list')) {
          return jsonResponse({
            'hash-u3': {
              networking: {
                host_ipv4: '203.0.113.32',
                ipv6_ip: '2001:db8::32',
                mapped_ports: {
                  '22': { host: 32232, tcp: true, udp: false }
                }
              }
            }
          })
        }

        return jsonResponse({ status: 'processed', message: { type: 'STORE' } })
      }
    }
  )

  assert.equal(result.itemHash, 'hash-u3')
  assert.equal(result.selectedCrn?.hash, 'crn-b')
  assert.equal(result.runtime?.hostIpv4, '203.0.113.32')
  assert.equal(result.runtime?.diagnostics?.state, 'ready')

  const forgetBodies = postedBodies.filter((body) => body.includes('"type":"FORGET"'))
  assert.equal(forgetBodies.length, 1)
  assert.match(forgetBodies[0], /hash-u1/)
})

test('executeDeployPlan configures orbitdb relay after mapped ports appear', async () => {
  const configureBodies: string[] = []
  const derivedBootstrapPublisherPrivateKey = deriveBootstrapPublisherPrivateKey({
    sourcePrivateKey: DEPLOY_PLAN.privateKey,
    profile: 'orbitdb-relay',
  })
  const expectedRelayIdentity = deriveLibp2pSecp256k1IdentityFromEvmKey(
    derivedBootstrapPublisherPrivateKey,
  )
  const result = await executeDeployPlan(
    {
      ...DEPLOY_PLAN,
      profile: 'orbitdb-relay',
      name: 'orbitdb-relay',
      requiredPorts: [
        { port: 22, tcp: true, udp: false, purpose: 'SSH' },
        { port: 80, tcp: true, udp: false, purpose: 'Temporary setup endpoint' },
        { port: 9090, tcp: true, udp: false, purpose: 'Metrics and health API' },
        { port: 9091, tcp: true, udp: false, purpose: 'Relay TCP' },
        { port: 443, tcp: true, udp: false, purpose: 'HTTPS and WSS proxy' },
        { port: 9093, tcp: false, udp: true, purpose: 'WebRTC' },
        { port: 9094, tcp: false, udp: true, purpose: 'QUIC' },
      ],
    },
    {
      sender: '0x1234',
      signer: async () => '0xsigned',
      hasher: (() => {
        let count = 0
        return () => `hash-o${++count}`
      })(),
      sleep: async () => undefined,
      tcpProbe: async () => ({ ok: true }),
      fetch: async (url, init) => {
        if (String(url).includes('crns-list.aleph.sh')) {
          return jsonResponse({
            crns: [{ hash: 'crn-1', name: 'CRN One', address: 'https://crn.example.com', score: 10, country_code: 'DE' }]
          })
        }

        if (String(url).includes('/api/v0/aggregates/0x1234.json')) {
          return jsonResponse({})
        }

        if (String(url).includes('/api/v0/messages/hash-o1') && !init?.method) {
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
            url: 'https://dragon-belt-friend-share.2n6.me',
            active: true
          })
        }

        if (String(url).includes('/v2/about/executions/list')) {
          return jsonResponse({
            'hash-o1': {
              networking: {
                host_ipv4: '203.0.113.8',
                ipv6_ip: '2001:db8::8',
                mapped_ports: {
                  '80': { host: 28080, tcp: true, udp: false },
                  '22': { host: 32022, tcp: true, udp: false },
                  '9090': { host: 29090, tcp: true, udp: false },
                  '9091': { host: 29091, tcp: true, udp: false },
                  '443': { host: 29443, tcp: true, udp: false },
                  '9093': { host: 29093, tcp: false, udp: true },
                  '9094': { host: 29094, tcp: false, udp: true }
                }
              }
            }
          })
        }

        if (String(url).includes('/health')) {
          return jsonResponse({ ok: true })
        }

        if (String(url).includes('/configure')) {
          configureBodies.push(String(init?.body ?? ''))
          return jsonResponse({ status: 'configured' })
        }

        if (String(url).includes('/metadata')) {
          return jsonResponse({
            status: 'ready',
            metadata: {
              peer_id: expectedRelayIdentity.peerId,
              probe_multiaddrs: [
                `/dns4/dragon-belt-friend-share.2n6.me/tcp/443/tls/ws/p2p/${expectedRelayIdentity.peerId}`,
              ],
              browser_bootstrap_multiaddrs: [
                `/dns4/dragon-belt-friend-share.2n6.me/tcp/443/tls/ws/p2p/${expectedRelayIdentity.peerId}`,
              ],
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
    }
  )

  assert.equal(result.itemHash, 'hash-o1')
  assert.equal(result.configuration?.metadata?.peer_id, expectedRelayIdentity.peerId)
  assert.equal(result.runtime?.hostIpv4, '203.0.113.8')
  assert.equal(result.verification?.ok, true)
  assert.equal(configureBodies.length, 1)
  assert.deepEqual(JSON.parse(configureBodies[0] ?? '{}'), {
    public_ipv4: '203.0.113.8',
    public_ipv6: '2001:db8::8',
    tcp_port: 29091,
    ws_port: 29443,
    proxy_url: 'https://dragon-belt-friend-share.2n6.me',
    metrics_port: 29090,
    metrics_https_port: 29443,
    webrtc_port: 29093,
    quic_port: 29094,
    // No key material: the setup endpoint is plain HTTP, and the guest
    // generates its own publisher key and libp2p identity.
    bootstrap_registration_id: 'relay:orbitdb-relay:orbitdb-relay',
  })
})

test('executeDeployPlan pushes the bootstrap owner authorization after the guest reports metadata', async () => {
  const configureBodies: string[] = []
  const derivedBootstrapPublisherPrivateKey = deriveBootstrapPublisherPrivateKey({
    sourcePrivateKey: DEPLOY_PLAN.privateKey,
    profile: 'orbitdb-relay',
  })
  const expectedRelayIdentity = deriveLibp2pSecp256k1IdentityFromEvmKey(
    derivedBootstrapPublisherPrivateKey,
  )
  const expectedPublisherIdentity = await createPrivateKeyIdentity(
    derivedBootstrapPublisherPrivateKey,
  )

  const result = await executeDeployPlan(
    {
      ...DEPLOY_PLAN,
      profile: 'orbitdb-relay',
      bootstrapPublisherPrivateKey: '',
      bootstrapOwnerPrivateKey: '0x8b3a350cf5c34c9194ca3a9d8b5421f0b2b7215e7ff5b0e97c85af9a81d3d1ad',
      rootfsItemHash: 'b'.repeat(64),
      rootfsVersion: '2026.05.30',
      requiredPorts: [
        { port: 22, tcp: true, udp: false, purpose: 'SSH' },
        { port: 80, tcp: true, udp: false, purpose: 'setup' },
        { port: 443, tcp: true, udp: false, purpose: 'wss proxy' },
        { port: 9090, tcp: true, udp: false, purpose: 'metrics' },
        { port: 9091, tcp: true, udp: false, purpose: 'relay tcp' },
        { port: 9093, tcp: false, udp: true, purpose: 'relay webrtc' },
        { port: 9094, tcp: false, udp: true, purpose: 'relay quic' }
      ]
    },
    {
      sender: '0x1234',
      signer: async () => '0xsigned',
      hasher: (() => {
        let count = 0
        return () => `hash-d${++count}`
      })(),
      sleep: async () => undefined,
      tcpProbe: async () => ({ ok: true }),
      fetch: async (url, init) => {
        if (String(url).includes('crns-list.aleph.sh')) {
          return jsonResponse({
            crns: [{ hash: 'crn-1', name: 'CRN One', address: 'https://crn.example.com', score: 10, country_code: 'DE' }]
          })
        }

        if (String(url).includes('/api/v0/aggregates/0x1234.json')) {
          return jsonResponse({})
        }

        if (String(url).includes('/api/v0/messages/hash-d1') && !init?.method) {
          return jsonResponse({ status: 'processed', details: { rootfs: 'b'.repeat(64) } })
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
            url: 'https://dragon-belt-friend-share.2n6.me',
            active: true
          })
        }

        if (String(url).includes('/v2/about/executions/list')) {
          return jsonResponse({
            'hash-d1': {
              networking: {
                host_ipv4: '203.0.113.9',
                ipv6_ip: '2001:db8::9',
                mapped_ports: {
                  '80': { host: 28080, tcp: true, udp: false },
                  '22': { host: 32022, tcp: true, udp: false },
                  '9090': { host: 29090, tcp: true, udp: false },
                  '9091': { host: 29091, tcp: true, udp: false },
                  '443': { host: 29443, tcp: true, udp: false },
                  '9093': { host: 29093, tcp: false, udp: true },
                  '9094': { host: 29094, tcp: false, udp: true }
                }
              }
            }
          })
        }

        if (String(url).includes('/health')) {
          return jsonResponse({ ok: true })
        }

        if (String(url).includes('/configure')) {
          configureBodies.push(String(init?.body ?? ''))
          return jsonResponse({ status: 'configured' })
        }

        if (String(url).includes('/metadata')) {
          return jsonResponse({
            status: 'ready',
            metadata: {
              peer_id: expectedRelayIdentity.peerId,
              probe_multiaddrs: [
                `/dns4/dragon-belt-friend-share.2n6.me/tcp/443/tls/ws/p2p/${expectedRelayIdentity.peerId}`,
              ],
              browser_bootstrap_multiaddrs: [
                `/dns4/dragon-belt-friend-share.2n6.me/tcp/443/tls/ws/p2p/${expectedRelayIdentity.peerId}`,
              ],
            }
          })
        }

        if (String(url).includes('/api/v0/posts.json')) {
          return jsonResponse({
            posts: [
              {
                item_hash: 'bootstrap-visible-hash',
                address: expectedPublisherIdentity.address,
                ref: 'simple-todo-bootstrap',
                type: 'relay-bootstrap-v2',
                content: {
                  peerId: expectedRelayIdentity.peerId,
                  multiaddrs: [
                    `/dns4/dragon-belt-friend-share.2n6.me/tcp/443/tls/ws/p2p/${expectedRelayIdentity.peerId}`,
                  ],
                  browserMultiaddrs: [
                    `/dns4/dragon-belt-friend-share.2n6.me/tcp/443/tls/ws/p2p/${expectedRelayIdentity.peerId}`,
                  ],
                  updatedAt: Date.now(),
                },
              },
            ],
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
    }
  )

  assert.equal(result.itemHash, 'hash-d1')

  // Two calls now: networking first, then the authorization once the guest
  // has reported the peerId it commits to. No call may carry key material —
  // the endpoint is plain HTTP.
  assert.equal(configureBodies.length, 2)
  const payloads = configureBodies.map((body) => JSON.parse(body || '{}'))
  for (const payload of payloads) {
    assert.equal(payload.bootstrap_owner_private_key, undefined)
    assert.equal(payload.bootstrap_publisher_private_key, undefined)
    assert.equal(payload.bootstrap_publisher_libp2p_identity_hex, undefined)
  }

  const authorizationConfigure = payloads.find(
    (payload) => typeof payload.bootstrap_owner_authorization_b64 === 'string'
  )
  assert.ok(authorizationConfigure, 'expected an authorization configure call')

  const authorization = JSON.parse(
    Buffer.from(
      authorizationConfigure.bootstrap_owner_authorization_b64,
      'base64'
    ).toString('utf8')
  ) as {
    scheme?: string
    payload?: { peerId?: string; publisherAddress?: string; ownerAddress?: string; registrationId?: string }
    signature?: string
  }

  assert.equal(authorization.scheme, 'personal_sign')
  assert.equal(authorization.payload?.peerId, expectedRelayIdentity.peerId)
  assert.equal(
    authorization.payload?.registrationId,
    'relay:orbitdb-relay:uc-go-peer:hash-d1'
  )
  assert.match(String(authorization.payload?.publisherAddress ?? ''), /^0x/i)
  assert.match(String(authorization.payload?.ownerAddress ?? ''), /^0x/i)
  assert.match(String(authorization.signature ?? ''), /^0x/i)
})

test('executeDeployPlan never sends key material to the plain-HTTP guest setup endpoint', async () => {
  const configureBodies: string[] = []
  const bootstrapPublisherPrivateKey =
    '0x59c6995e998f97a5a0044966f0945382d7d5d95f993dbf3b61e64d1d4438f3f0'
  const bootstrapOwnerPrivateKey =
    '0x8b3a350cf5c34c9194ca3a545d5487d74f7382a1d9dfc021f7b64fc6d98f6c1d'
  const expectedRelayIdentity = deriveLibp2pSecp256k1IdentityFromEvmKey(
    bootstrapPublisherPrivateKey
  )

  const result = await executeDeployPlan(
    {
      ...DEPLOY_PLAN,
      profile: 'orbitdb-relay',
      bootstrapPublisherPrivateKey,
      bootstrapOwnerPrivateKey
    },
    {
      sender: '0x1234',
      signer: async () => '0xsigned',
      hasher: (() => {
        let count = 0
        return () => `hash-s${++count}`
      })(),
      sleep: async () => undefined,
      tcpProbe: async () => ({ ok: true }),
      fetch: async (url, init) => {
        if (String(url).includes('crns-list.aleph.sh')) {
          return jsonResponse({
            crns: [{ hash: 'crn-1', name: 'CRN One', address: 'https://crn.example.com', score: 10, country_code: 'DE' }]
          })
        }

        if (String(url).includes('/api/v0/aggregates/0x1234.json')) {
          return jsonResponse({})
        }

        if (String(url).includes('/api/v0/messages/hash-s1') && !init?.method) {
          return jsonResponse({ status: 'processed', details: { rootfs: 'b'.repeat(64) } })
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
            url: 'https://dragon-belt-friend-share.2n6.me',
            active: true
          })
        }

        if (String(url).includes('/v2/about/executions/list')) {
          return jsonResponse({
            'hash-s1': {
              networking: {
                host_ipv4: '203.0.113.9',
                ipv6_ip: '2001:db8::109',
                mapped_ports: {
                  '80': { host: 28080, tcp: true, udp: false },
                  '22': { host: 32022, tcp: true, udp: false },
                  '9090': { host: 29090, tcp: true, udp: false },
                  '9091': { host: 29091, tcp: true, udp: false },
                  '443': { host: 29443, tcp: true, udp: false },
                  '9093': { host: 29093, tcp: false, udp: true },
                  '9094': { host: 29094, tcp: false, udp: true }
                }
              }
            }
          })
        }

        if (String(url).includes('/health')) {
          return jsonResponse({ ok: true })
        }

        if (String(url).includes('/configure')) {
          configureBodies.push(String(init?.body ?? ''))
          return jsonResponse({ status: 'configured' })
        }

        if (String(url).includes('/metadata')) {
          return jsonResponse({
            status: 'ready',
            metadata: {
              peer_id: expectedRelayIdentity.peerId,
              probe_multiaddrs: [`/dns4/dragon-belt-friend-share.2n6.me/tcp/443/tls/ws/p2p/${expectedRelayIdentity.peerId}`],
              browser_bootstrap_multiaddrs: [`/dns4/dragon-belt-friend-share.2n6.me/tcp/443/tls/ws/p2p/${expectedRelayIdentity.peerId}`]
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
    }
  )

  assert.equal(result.itemHash, 'hash-s1')

  // The guest setup endpoint is plain HTTP, so no key material may ever be
  // sent to it — not even when the plan supplies keys.
  for (const body of configureBodies) {
    const payload = JSON.parse(body || '{}')
    assert.equal(payload.bootstrap_publisher_private_key, undefined)
    assert.equal(payload.bootstrap_publisher_libp2p_identity_hex, undefined)
    assert.equal(payload.bootstrap_publisher_libp2p_identity_b64, undefined)
    assert.equal(payload.bootstrap_owner_private_key, undefined)
  }

  // The authorization commits to the guest's real peerId, so it can only be
  // signed after the guest reports metadata — it arrives in a second pass.
  // The authorization pass only runs once the registration is published and
  // visible; this scenario stops earlier, so only networking was configured.
  assert.ok(configureBodies.length >= 1)

  // The reported peerId is the source of truth, not a preseeded prediction.
  assert.equal(result.configuration?.metadata?.peer_id, expectedRelayIdentity.peerId)
})

test('executeDeployPlan configures relay Caddy when a reserved 2n6 proxy URL is not marked active yet', async () => {
  const configureBodies: string[] = []
  let twoN6Lookups = 0
  const bootstrapPublisherPrivateKey =
    '0x59c6995e998f97a5a0044966f0945382d7d5d95f993dbf3b61e64d1d4438f3f0'
  const expectedRelayIdentity = deriveLibp2pSecp256k1IdentityFromEvmKey(
    bootstrapPublisherPrivateKey
  )

  await executeDeployPlan(
    {
      ...DEPLOY_PLAN,
      bootstrapPublisherPrivateKey,
    },
    {
      sender: '0x1234',
      signer: async () => '0xsigned',
      hasher: (() => {
        let count = 0
        return () => `hash-${++count}`
      })(),
      sleep: async () => undefined,
      tcpProbe: async () => ({ ok: true }),
      fetch: async (url, init) => {
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
          twoN6Lookups += 1
          return jsonResponse({
            url: 'https://relay.example.com',
            active: false
          })
        }

        if (String(url).includes('/v2/about/executions/list')) {
          return jsonResponse({
            'hash-1': {
              networking: {
                host_ipv4: '203.0.113.7',
                ipv6_ip: '2001:db8::7',
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
          configureBodies.push(String(init?.body ?? ''))
          return jsonResponse({ status: 'configured' })
        }

        if (String(url).includes('/metadata')) {
          return jsonResponse({
            status: 'ready',
            metadata: {
              peer_id: expectedRelayIdentity.peerId,
              probe_multiaddrs: [`/ip4/203.0.113.7/tcp/32095/p2p/${expectedRelayIdentity.peerId}`],
              browser_bootstrap_multiaddrs: [`/dns4/relay.example.com/tcp/443/tls/ws/p2p/${expectedRelayIdentity.peerId}`]
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
    }
  )

  assert.ok(twoN6Lookups >= 1)
  assert.equal(configureBodies.length, 1)
  assert.equal(
    JSON.parse(configureBodies[0]).proxy_url,
    'https://relay.example.com'
  )
})
