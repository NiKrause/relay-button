import test from 'node:test'
import assert from 'node:assert/strict'

import { probeRootfsGateway, resolveRootfsReference, validateRootfsManifest, verifyRootfsExists } from '../src/manifests.ts'

const validUcManifest = {
  profile: 'uc-go-peer',
  version: 'uc-go-peer-git-20260512-5c3429a',
  rootfsInstallStrategy: 'prebaked',
  requiresBootstrapNetwork: false,
  bootstrapSummary: 'Dependencies are preinstalled in the image.',
  rootfsSourceSizeBytes: 675115824,
  requiredPortForwards: [
    { port: 22, tcp: true, udp: false, purpose: 'SSH' },
    { port: 80, tcp: true, udp: false, purpose: 'Temporary setup endpoint' },
    { port: 443, tcp: true, udp: false, purpose: 'Caddy HTTPS and WSS proxy' },
    { port: 9095, tcp: true, udp: true, purpose: 'libp2p raw TCP and UDP transports' }
  ],
  rootfsCid: 'QmYMmv9xC97ziCc93iWzK4r9N2WR7onq3K84tJLpi2ybez',
  rootfsItemHash: '380b99e0577fb7771f1b3c0a369f4abff9094e9205b0b466783453299ef9f4f2',
  rootfsSizeMiB: 20480,
  createdAt: '2026-05-12T07:40:09Z',
  notes: 'Reference uc-go-peer manifest'
}

test('accepts the current uc-go-peer style manifest', () => {
  const result = validateRootfsManifest(validUcManifest)
  assert.equal(result.valid, true)
  assert.deepEqual(result.errors, [])
})

test('rejects a missing manifest', () => {
  const result = validateRootfsManifest(null)
  assert.equal(result.valid, false)
  assert.deepEqual(result.errors, ['Rootfs manifest is missing.'])
})

test('rejects invalid rootfs item hashes', () => {
  const result = validateRootfsManifest({
    ...validUcManifest,
    rootfsItemHash: 'not-a-real-item-hash'
  })

  assert.equal(result.valid, false)
  assert.match(result.errors.join('\n'), /Rootfs ItemHash/)
})

test('rejects invalid port forward entries', () => {
  const result = validateRootfsManifest({
    ...validUcManifest,
    requiredPortForwards: [
      { port: 0, tcp: false, udp: false, purpose: '' }
    ]
  })

  assert.equal(result.valid, false)
  assert.equal(result.errors.length, 3)
})

test('accepts manifests without optional CID and item hash fields', () => {
  const result = validateRootfsManifest({
    profile: 'uc-go-peer',
    version: 'local-dev-build',
    rootfsInstallStrategy: 'prebaked',
    requiresBootstrapNetwork: false,
    bootstrapSummary: 'Dependencies are preinstalled in the image.',
    rootfsSizeMiB: 20480,
    requiredPortForwards: [{ port: 22, tcp: true, udp: false, purpose: 'SSH' }],
    createdAt: '2026-05-12T07:40:09Z'
  })

  assert.equal(result.valid, true)
})

test('verifyRootfsExists returns true for STORE messages', async () => {
  const result = await verifyRootfsExists(validUcManifest.rootfsItemHash!, {
    fetch: async () => ({
      ok: true,
      status: 200,
      async json() {
        return { type: 'STORE' }
      }
    })
  })

  assert.equal(result, true)
})

test('verifyRootfsExists returns false for missing messages', async () => {
  const result = await verifyRootfsExists(validUcManifest.rootfsItemHash!, {
    fetch: async () => ({
      ok: false,
      status: 404,
      async json() {
        return {}
      }
    })
  })

  assert.equal(result, false)
})

test('probeRootfsGateway reports reachable for successful HEAD checks', async () => {
  const result = await probeRootfsGateway('QmExample', {
    fetch: async () => ({
      ok: true,
      status: 200,
      async json() {
        return {}
      }
    })
  })

  assert.equal(result.gatewayStatus, 'reachable')
  assert.match(result.gatewayUrl!, /QmExample/)
})

test('resolveRootfsReference returns normalized processed store references', async () => {
  const result = await resolveRootfsReference(validUcManifest.rootfsItemHash!, {
    fetch: async (url, init) => {
      if (String(init?.method) === 'HEAD') {
        return {
          ok: true,
          status: 200,
          async json() {
            return {}
          }
        }
      }

      assert.match(url, /api\/v0\/messages/)
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            status: 'processed',
            type: 'STORE',
            reception_time: '2026-05-12T07:40:09Z',
            messages: [
              {
                content: {
                  item_hash: 'QmExampleCid'
                }
              }
            ]
          }
        }
      }
    }
  })

  assert.ok(result)
  assert.equal(result?.messageStatus, 'processed')
  assert.equal(result?.messageType, 'STORE')
  assert.equal(result?.cid, 'QmExampleCid')
  assert.equal(result?.gatewayStatus, 'reachable')
})

test('resolveRootfsReference returns detailed rejection reason when Aleph rejects a rootfs reference', async () => {
  const result = await resolveRootfsReference(validUcManifest.rootfsItemHash!, {
    fetch: async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          status: 'rejected',
          type: 'STORE',
          error_code: 5,
          details: {
            errors: [
              {
                account_balance: 1,
                required_balance: 2.5
              }
            ]
          }
        }
      }
    })
  })

  assert.ok(result)
  assert.equal(result?.messageStatus, 'rejected')
  assert.match(result?.rejectionReason ?? '', /insufficient hold balance/i)
  assert.equal(result?.gatewayStatus, 'unknown')
})

test('resolveRootfsReference explains a rootfs STORE being removed for insufficient publisher credits', async () => {
  const result = await resolveRootfsReference(validUcManifest.rootfsItemHash!, {
    fetch: async () => ({
      ok: true,
      status: 200,
      async json() {
        return { status: 'removing', type: 'STORE', reason: 'balance_insufficient' }
      }
    })
  })

  assert.equal(result?.messageStatus, 'removing')
  assert.match(result?.rejectionReason ?? '', /publisher no longer has enough Aleph credits/i)
  assert.match(result?.rejectionReason ?? '', /connected MetaMask balance may be sufficient/i)
})
