import test from 'node:test'
import assert from 'node:assert/strict'

import { publishRelayBootstrapRegistration } from '../src/bootstrap-registration.ts'

test('publishRelayBootstrapRegistration signs and broadcasts filtered public bootstrap addrs', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []

  const result = await publishRelayBootstrapRegistration({
    sender: '0xabc',
    signer: async () => 'signed1234',
    hasher: async () => 'hash1234',
    peerId: '12D3KooWPublic',
    multiaddrs: [
      '/ip4/203.0.113.10/tcp/9095/p2p/12D3KooWPublic',
      '/ip4/127.0.0.1/tcp/9095/p2p/12D3KooWLocal'
    ],
    browserMultiaddrs: [
      '/dns4/relay.example.com/tcp/443/tls/ws/p2p/12D3KooWPublic',
      '/dns4/localhost/tcp/443/tls/ws/p2p/12D3KooWLocal'
    ],
    fetch: async (url, init) => {
      calls.push({ url, init })
      return {
        ok: true,
        status: 202,
        async json() {
          return {
            message_status: 'pending',
            publication_status: { status: 'success' }
          }
        }
      }
    }
  })

  assert.equal(result.status, 'published')
  assert.equal(result.itemHash, 'hash1234')
  assert.deepEqual(result.publishedMultiaddrs, [
    '/ip4/203.0.113.10/tcp/9095/p2p/12D3KooWPublic'
  ])
  assert.deepEqual(result.publishedBrowserMultiaddrs, [
    '/dns4/relay.example.com/tcp/443/tls/ws/p2p/12D3KooWPublic'
  ])
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /\/api\/v0\/messages$/)
  assert.equal(calls[0].init?.method, 'POST')

  const body = JSON.parse(String(calls[0].init?.body)) as {
    sync?: boolean
    message?: {
      type: string
      item_content: string
      signature: string
    }
  }

  assert.equal(body.sync, true)
  assert.equal(body.message?.type, 'POST')
  assert.equal(body.message?.signature, '0xsigned1234')

  const itemContent = JSON.parse(String(body.message?.item_content)) as {
    content: {
      multiaddrs: string[]
      browserMultiaddrs?: string[]
    }
  }
  assert.deepEqual(itemContent.content.multiaddrs, result.publishedMultiaddrs)
  assert.deepEqual(
    itemContent.content.browserMultiaddrs,
    result.publishedBrowserMultiaddrs
  )
})

test('publishRelayBootstrapRegistration skips publication when no public addrs remain', async () => {
  let called = false

  const result = await publishRelayBootstrapRegistration({
    sender: '0xabc',
    signer: async () => 'signed1234',
    hasher: async () => 'hash1234',
    peerId: '12D3KooWLocal',
    multiaddrs: [
      '/ip4/127.0.0.1/tcp/9095/p2p/12D3KooWLocal',
      '/dns4/localhost/tcp/443/tls/ws/p2p/12D3KooWLocal'
    ],
    fetch: async () => {
      called = true
      return {
        ok: true,
        status: 202,
        async json() {
          return {}
        }
      }
    }
  })

  assert.equal(result.status, 'skipped')
  assert.match(result.reason ?? '', /No public relay multiaddrs/)
  assert.equal(called, false)
  assert.deepEqual(result.publishedMultiaddrs, [])
})
