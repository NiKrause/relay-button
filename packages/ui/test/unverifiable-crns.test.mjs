import assert from 'node:assert/strict'
import test from 'node:test'

import {
  demoteUnverifiableCrns,
  forgetUnverifiableCrns,
  isUnverifiableNodeError,
  rememberUnverifiableCrn,
  unverifiableCrnHashes,
} from '../dist/shared/index.js'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)

function memoryStorage() {
  const items = new Map()
  return {
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => items.set(key, String(value)),
    removeItem: (key) => items.delete(key),
    items,
  }
}

test('only a missing VCEK counts as an unverifiable node', () => {
  assert.equal(isUnverifiableNodeError('AMD KDS answered 404 for https://kdsintf.amd.com/vcek/v1/Genoa/…'), true)
  assert.equal(isUnverifiableNodeError('AMD KDS answered 429'), false)
  assert.equal(isUnverifiableNodeError('rejected during the RA-TLS handshake: measurement'), false)
})

test('a refused node goes last for a week, unless the person pinned it', () => {
  forgetUnverifiableCrns()
  const now = Date.UTC(2026, 9, 17)
  rememberUnverifiableCrn(A, undefined, now)
  const crns = [{ hash: A }, { hash: B }, { hash: C }]
  assert.deepEqual(demoteUnverifiableCrns(crns, unverifiableCrnHashes(undefined, now), null).map((c) => c.hash), [B, C, A])
  assert.deepEqual(demoteUnverifiableCrns(crns, unverifiableCrnHashes(undefined, now), A).map((c) => c.hash), [A, B, C])
  assert.equal(unverifiableCrnHashes(undefined, now + 8 * 24 * 3600 * 1000).size, 0, 'forgotten after a week')
})

test('persisted only under the key the site names', () => {
  forgetUnverifiableCrns()
  const storage = memoryStorage()
  const previous = globalThis.localStorage
  globalThis.localStorage = storage
  try {
    const now = Date.UTC(2026, 9, 17)
    rememberUnverifiableCrn(A, undefined, now)
    assert.equal(storage.items.size, 0, 'nothing written without a key')
    rememberUnverifiableCrn(B, 'site.refused-nodes', now)
    assert.deepEqual(Object.keys(JSON.parse(storage.getItem('site.refused-nodes'))).sort(), [A, B])
    forgetUnverifiableCrns()
    assert.deepEqual([...unverifiableCrnHashes('site.refused-nodes', now)].sort(), [A, B], 'read back after a reload')
    storage.setItem('broken', '{not json')
    assert.doesNotThrow(() => unverifiableCrnHashes('broken', now))
  } finally {
    globalThis.localStorage = previous
    forgetUnverifiableCrns()
  }
})
