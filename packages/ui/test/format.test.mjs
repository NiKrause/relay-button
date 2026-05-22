import assert from 'node:assert/strict'
import test from 'node:test'

import { shortHash } from '../dist/shared/index.js'

test('shortHash compresses long hashes', () => {
  assert.equal(shortHash('abcdef0123456789', 4, 4), 'abcd...6789')
})
