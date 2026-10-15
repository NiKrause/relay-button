import assert from 'node:assert/strict'
import test from 'node:test'

import { formatDateTime, formatTierSpecLabel, shortHash } from '../dist/shared/index.js'

test('shortHash compresses long hashes', () => {
  assert.equal(shortHash('abcdef0123456789', 4, 4), 'abcd...6789')
})

test('formatDateTime treats Unix-second timestamps as seconds', () => {
  const formatted = formatDateTime(1747962535)
  assert.equal(/1970/.test(formatted), false)
})

test('formatTierSpecLabel renders compact resource text', () => {
  assert.equal(
    formatTierSpecLabel(2, 4096, 20480),
    '(2 vCPU · 4.0 GiB RAM · 20 GiB disk)'
  )
})

test('formatCrnOptionLabel adds country, version and operator for a confidential VM', async () => {
  const { formatCrnOptionLabel } = await import('../dist/shared/index.js')
  const option = { hash: 'abcdef0123', name: 'node-1', score: 0.987, country: 'FR', version: '2.1.4', operator: '0x1234…abcd' }
  assert.equal(formatCrnOptionLabel(option), 'node-1 · 0.99')
  assert.equal(formatCrnOptionLabel(option, true), 'node-1 · 0.99 · FR · aleph-vm 2.1.4 · operator 0x1234…abcd')
  assert.equal(formatCrnOptionLabel({ hash: 'abcdef0123', name: null, score: null }, true), 'abcdef01')
})
