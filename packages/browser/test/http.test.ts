import assert from 'node:assert/strict'
import test from 'node:test'

import { fetchWithTimeout } from '../src/http.ts'

test('fetchWithTimeout adds a cache-busting timestamp for URL-like inputs', async () => {
  const originalFetch = globalThis.fetch

  try {
    let capturedUrl = ''
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      capturedUrl = String(input)
      return new Response('{}', { status: 200 })
    }) as typeof fetch

    await fetchWithTimeout('https://example.com/test?x=1')

    const url = new URL(capturedUrl)
    assert.equal(url.searchParams.get('x'), '1')
    assert.ok(url.searchParams.has('_ts'))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('fetchWithTimeout translates AbortError into a timeout error', async () => {
  const originalFetch = globalThis.fetch

  try {
    globalThis.fetch = (async () => {
      throw new DOMException('aborted', 'AbortError')
    }) as typeof fetch

    await assert.rejects(() => fetchWithTimeout('https://example.com/test', {}, 1000), {
      message: 'Request timed out after 1s.'
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})
