import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseCleanupCliArgs } from '../src/cleanup-cli.ts'

const HASH = 'a'.repeat(64)

test('parses instance hash from flags and derives defaults', () => {
  const options = parseCleanupCliArgs([`--instance-hash=${HASH}`], {})
  assert.equal(options.instanceHash, HASH)
  assert.deepEqual(options.apiHosts, ['https://api2.aleph.im', 'https://api.aleph.im'])
  assert.equal(options.evidencePath, `playwright-runner-cleanup-${HASH.slice(0, 12)}.json`)
  assert.match(options.reason, /Ephemeral Playwright runner cleanup/u)
})

test('supports space-separated flag values and env fallbacks', () => {
  const options = parseCleanupCliArgs(['--evidence-path', 'out/evidence.json'], {
    ALEPH_PLAYWRIGHT_INSTANCE_HASH: HASH,
    ALEPH_VM_API_HOSTS: 'https://api.aleph.im',
  })
  assert.equal(options.instanceHash, HASH)
  assert.deepEqual(options.apiHosts, ['https://api.aleph.im'])
  assert.equal(options.evidencePath, 'out/evidence.json')
})

test('rejects missing or malformed instance hashes', () => {
  assert.throws(() => parseCleanupCliArgs([], {}), /exact INSTANCE hash/u)
  assert.throws(() => parseCleanupCliArgs(['--instance-hash', 'nope'], {}), /exact INSTANCE hash/u)
})

test('never selects api3 hosts even when requested', () => {
  const options = parseCleanupCliArgs([`--instance-hash=${HASH}`, '--api-hosts', 'https://api3.aleph.im'], {})
  assert.deepEqual(options.apiHosts, ['https://api2.aleph.im', 'https://api.aleph.im'])
})
