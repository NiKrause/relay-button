import test from 'node:test'
import assert from 'node:assert/strict'

import type { RootfsManifest, RootfsManifestState, RootfsResolution } from '../src/index.ts'

test('shared manifest-related types describe the current contract shape', () => {
  const manifest: RootfsManifest = {
    profile: 'uc-go-peer',
    version: 'uc-go-peer-git-20260512-5c3429a',
    rootfsInstallStrategy: 'prebaked',
    requiresBootstrapNetwork: false,
    bootstrapSummary: 'Dependencies are preinstalled in the image.',
    rootfsCid: 'QmExample',
    rootfsItemHash: '380b99e0577fb7771f1b3c0a369f4abff9094e9205b0b466783453299ef9f4f2',
    rootfsSizeMiB: 20480,
    rootfsSourceSizeBytes: 675115824,
    requiredPortForwards: [{ port: 22, tcp: true, udp: false, purpose: 'SSH' }],
    createdAt: '2026-05-12T07:40:09Z'
  }

  const state: RootfsManifestState = {
    manifest,
    valid: true,
    errors: []
  }

  const resolution: RootfsResolution = {
    itemHash: manifest.rootfsItemHash!,
    messageStatus: 'processed',
    messageType: 'STORE',
    cid: manifest.rootfsCid!,
    gatewayUrl: 'https://ipfs.aleph.cloud/ipfs/QmExample',
    gatewayStatus: 'reachable'
  }

  assert.equal(state.valid, true)
  assert.equal(resolution.messageStatus, 'processed')
})
