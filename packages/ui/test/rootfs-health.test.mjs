import assert from 'node:assert/strict'
import test from 'node:test'

import { rootfsHealth } from '../dist/shared/index.js'

const manifestState = {
  valid: true,
  errors: [],
  manifest: { rootfsItemHash: 'f'.repeat(64) }
}

test('describes a processed rootfs without a gateway URL as verified', () => {
  assert.deepEqual(
    rootfsHealth({
      manifestState,
      rootfsVerified: true,
      resolution: {
        messageStatus: 'processed',
        gatewayUrl: null
      }
    }),
    {
      tone: 'ok',
      label: 'deployable',
      detail: 'Rootfs verified on Aleph.',
      code: 'rootfs-ready'
    }
  )
})

test('exposes an actionable blocker for a removed rootfs STORE', () => {
  const health = rootfsHealth({
    manifestState,
    rootfsVerified: true,
    resolution: {
      messageStatus: 'removing',
      messageType: 'STORE',
      rejectionReason: 'The rootfs STORE is being removed because its publisher no longer has enough Aleph credits.'
    }
  })
  assert.equal(health.tone, 'error')
  assert.equal(health.code, 'rootfs-unavailable')
  assert.match(health.detail, /publisher no longer has enough Aleph credits/i)
})

test('shows the gateway URL when one is available', () => {
  assert.equal(
    rootfsHealth({
      manifestState,
      rootfsVerified: true,
      resolution: {
        messageStatus: 'processed',
        gatewayUrl: 'https://example.test/rootfs'
      }
    }).detail,
    'https://example.test/rootfs'
  )
})
