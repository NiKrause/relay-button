import assert from 'node:assert/strict'
import test from 'node:test'

import { toChecksumAddress } from '../dist/shared/index.mjs'

test('toChecksumAddress normalizes a lowercase EVM address', () => {
  assert.equal(
    toChecksumAddress('0x52908400098527886e0f7030069857d2e4169ee7'),
    '0x52908400098527886E0F7030069857D2E4169EE7'
  )
})

test('toChecksumAddress rejects an invalid EVM address', () => {
  assert.throws(() => toChecksumAddress('not-an-address'), /Invalid EVM address\./)
})
