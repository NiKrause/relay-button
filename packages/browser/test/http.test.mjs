import assert from 'node:assert/strict'
import test from 'node:test'

import { fetchWithTimeout } from '../dist/index.js'

test('fetchWithTimeout adds a cache-busting timestamp for URL-like inputs', async () => {
  const originalFetch = globalThis.fetch

  try {
    let capturedUrl = ''
    globalThis.fetch = async (input) => {
      capturedUrl = String(input)
      return new Response('{}', { status: 200 })
    }

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
    globalThis.fetch = async () => {
      throw new DOMException('aborted', 'AbortError')
    }

    await assert.rejects(() => fetchWithTimeout('https://example.com/test', {}, 1000), {
      message: 'Request timed out after 1s.'
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('fetchWithTimeout preserves relative string inputs when no base URL is available', async () => {
  const originalFetch = globalThis.fetch
  const originalLocation = globalThis.location

  try {
    let capturedInput = ''
    globalThis.fetch = async (input) => {
      capturedInput = String(input)
      return new Response('{}', { status: 200 })
    }
    delete globalThis.location

    await fetchWithTimeout('./rootfs-manifest.json')

    assert.equal(capturedInput, './rootfs-manifest.json')
  } finally {
    globalThis.fetch = originalFetch
    globalThis.location = originalLocation
  }
})
