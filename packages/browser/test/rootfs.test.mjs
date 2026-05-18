import assert from 'node:assert/strict'
import test from 'node:test'

import {
  loadRootfsManifest,
  resolveRootfsReference,
  validateRootfsManifest,
  verifyRootfsExists
} from '../dist/index.js'

test('validateRootfsManifest accepts a complete manifest', () => {
  const result = validateRootfsManifest({
    profile: 'orbitdb-relay-pinner',
    version: 'relay-v0.1.0',
    rootfsInstallStrategy: 'thin',
    requiresBootstrapNetwork: true,
    bootstrapSummary: 'First boot installs runtime packages and dependencies.',
    requiredPortForwards: [
      { port: 22, tcp: true, udp: false, purpose: 'SSH' },
      { port: 9091, tcp: true, udp: false, purpose: 'libp2p TCP' }
    ],
    rootfsItemHash: 'f'.repeat(64),
    rootfsSizeMiB: 20480,
    rootfsSourceSizeBytes: 2445860819,
    createdAt: '2026-04-15'
  })

  assert.equal(result.valid, true)
  assert.deepEqual(result.errors, [])
})

test('loadRootfsManifest supports remote absolute URLs', async () => {
  const originalFetch = globalThis.fetch

  try {
    let capturedUrl = ''
    globalThis.fetch = async (input) => {
      capturedUrl = String(input)
      return new Response(
        JSON.stringify({
          profile: 'orbitdb-relay-pinner',
          version: 'relay-v0.1.0',
          rootfsInstallStrategy: 'thin',
          requiresBootstrapNetwork: true,
          bootstrapSummary: 'Remote manifest.',
          requiredPortForwards: [{ port: 22, tcp: true, udp: false, purpose: 'SSH' }],
          rootfsItemHash: 'f'.repeat(64),
          rootfsSizeMiB: 20480,
          createdAt: '2026-04-15'
        }),
        { status: 200 }
      )
    }

    const result = await loadRootfsManifest('https://example.com/rootfs-manifest.json')
    assert.equal(capturedUrl.startsWith('https://example.com/rootfs-manifest.json'), true)
    assert.equal(result.valid, true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('loadRootfsManifest supports relative URLs with an explicit remote base URL', async () => {
  const originalFetch = globalThis.fetch

  try {
    let capturedUrl = ''
    globalThis.fetch = async (input) => {
      capturedUrl = String(input)
      return new Response(
        JSON.stringify({
          profile: 'orbitdb-relay-pinner',
          version: 'relay-v0.1.0',
          rootfsInstallStrategy: 'thin',
          requiresBootstrapNetwork: true,
          bootstrapSummary: 'Remote base manifest.',
          requiredPortForwards: [{ port: 22, tcp: true, udp: false, purpose: 'SSH' }],
          rootfsItemHash: 'f'.repeat(64),
          rootfsSizeMiB: 20480,
          createdAt: '2026-04-15'
        }),
        { status: 200 }
      )
    }

    const result = await loadRootfsManifest('./rootfs-manifest.json', {
      baseUrl: 'https://example.com/deployer/'
    })
    assert.equal(capturedUrl.startsWith('https://example.com/deployer/rootfs-manifest.json'), true)
    assert.equal(result.valid, true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('verifyRootfsExists accepts a store message returned in the Aleph messages array shape', async () => {
  const originalFetch = globalThis.fetch

  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          status: 'pending',
          messages: [{ type: 'STORE' }]
        }),
        { status: 200 }
      )

    await assert.doesNotReject(() => verifyRootfsExists('f'.repeat(64)))
    const exists = await verifyRootfsExists('f'.repeat(64))
    assert.equal(exists, true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('resolveRootfsReference resolves CID and Aleph status from a store message', async () => {
  const originalFetch = globalThis.fetch

  try {
    let callIndex = 0
    globalThis.fetch = async () => {
      callIndex += 1
      if (callIndex === 1) {
        return new Response(
          JSON.stringify({
            status: 'pending',
            reception_time: '2026-04-16T13:28:47.044481Z',
            messages: [
              {
                type: 'STORE',
                content: {
                  item_hash: 'QmExampleCid'
                }
              }
            ]
          }),
          { status: 200 }
        )
      }

      return new Response('', { status: 200 })
    }

    const result = await resolveRootfsReference('f'.repeat(64))
    assert.deepEqual(result, {
      itemHash: 'f'.repeat(64),
      messageStatus: 'pending',
      messageType: 'STORE',
      cid: 'QmExampleCid',
      receptionTime: '2026-04-16T13:28:47.044481Z',
      rejectionErrorCode: null,
      rejectionReason: null,
      gatewayUrl: 'https://ipfs.aleph.cloud/ipfs/QmExampleCid',
      gatewayStatus: 'reachable',
      gatewayError: null
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})
