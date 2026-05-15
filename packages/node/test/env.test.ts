import test from 'node:test'
import assert from 'node:assert/strict'

import { booleanEnv, integerEnv, jsonEnv, optionalEnv, requiredEnv } from '../src/env.ts'

test('requiredEnv returns present values and rejects missing ones', () => {
  assert.equal(requiredEnv('FOO', { FOO: 'bar' }), 'bar')
  assert.throws(() => requiredEnv('MISSING', {}), /Missing required environment variable MISSING/)
})

test('optionalEnv returns fallback when the variable is absent', () => {
  assert.equal(optionalEnv('FOO', 'fallback', {}), 'fallback')
})

test('integerEnv parses integer values', () => {
  assert.equal(integerEnv('COUNT', 1, { COUNT: '42' }), 42)
  assert.throws(() => integerEnv('COUNT', 1, { COUNT: 'oops' }), /COUNT must be an integer/)
})

test('booleanEnv parses common boolean-like values', () => {
  assert.equal(booleanEnv('FLAG', false, { FLAG: 'yes' }), true)
  assert.equal(booleanEnv('FLAG', true, { FLAG: '0' }), false)
  assert.throws(() => booleanEnv('FLAG', false, { FLAG: 'maybe' }), /FLAG must be a boolean-like value/)
})

test('jsonEnv parses json values', () => {
  assert.deepEqual(jsonEnv<{ a: number }>('JSON', '{}', { JSON: '{"a":1}' }), { a: 1 })
  assert.throws(() => jsonEnv('JSON', '{}', { JSON: '{bad}' }), /JSON must be valid JSON/)
})
