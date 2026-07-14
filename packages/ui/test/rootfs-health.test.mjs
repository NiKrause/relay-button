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
      detail: 'Rootfs verified on Aleph.'
    }
  )
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
