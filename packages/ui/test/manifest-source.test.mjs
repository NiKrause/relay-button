import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveManifestSource } from '../dist/shared/index.mjs'

test('resolveManifestSource parses pasted manifest JSON', () => {
  const result = resolveManifestSource({
    manifestJson: JSON.stringify({
      profile: 'orbitdb-relay',
      version: 'relay-v0.1.0',
      rootfsItemHash: 'f'.repeat(64),
      rootfsSizeMiB: 20480,
      createdAt: '2026-05-22T00:00:00.000Z'
    })
  })

  assert.equal(result?.valid, true)
  assert.equal(result?.manifest?.version, 'relay-v0.1.0')
})

test('resolveManifestSource reports invalid pasted JSON', () => {
  const result = resolveManifestSource({
    manifestJson: '{bad json'
  })

  assert.equal(result?.valid, false)
  assert.equal(Array.isArray(result?.errors), true)
})
