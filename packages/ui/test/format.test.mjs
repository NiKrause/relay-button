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
