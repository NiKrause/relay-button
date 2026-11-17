import assert from 'node:assert/strict'
import test from 'node:test'

import { UI_SOURCE_URL, resolveSourceUrl } from '../dist/shared/index.js'

test('the panel links to the widget repository unless told otherwise', () => {
  assert.equal(resolveSourceUrl(undefined), UI_SOURCE_URL)
  assert.equal(resolveSourceUrl('https://github.com/example/fork '), 'https://github.com/example/fork')
  assert.equal(resolveSourceUrl(''), null)
  assert.equal(resolveSourceUrl(null), null)
})
