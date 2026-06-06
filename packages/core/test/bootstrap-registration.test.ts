import test from 'node:test'
import assert from 'node:assert/strict'

import {
  publishRelayBootstrapRegistration,
  waitForRelayBootstrapRegistration,
} from '../src/bootstrap-registration.ts'

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

test('publishRelayBootstrapRegistration can forget older records for the same registration id', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  let hashCall = 0

  const result = await publishRelayBootstrapRegistration({
    sender: '0xabc',
    signer: async () => 'signed1234',
    hasher: async () => (++hashCall === 1 ? 'post-hash' : 'forget-hash'),
    peerId: '12D3KooWPublic',
    registrationId: 'relay:uc-go-peer:demo',
    forgetPrevious: true,
    multiaddrs: ['/ip4/203.0.113.10/tcp/9095/p2p/12D3KooWPublic'],
    fetch: async (url, init) => {
      calls.push({ url, init })
      if (String(url).includes('/api/v0/posts.json')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              posts: [
                {
                  item_hash: 'older-item-hash',
                  address: '0xabc',
                  ref: 'simple-todo-bootstrap',
                  type: 'relay-bootstrap',
                  content: {
                    peerId: '12D3KooWPublic',
                    registrationId: 'relay:uc-go-peer:demo',
                    updatedAt: Date.now() - 1_000,
                    multiaddrs: ['/ip4/203.0.113.9/tcp/9095/p2p/12D3KooWPublic']
                  }
                }
              ]
            }
          }
        }
      }

      return {
        ok: true,
        status: 202,
        async json() {
          return {
            message_status: 'processed',
            publication_status: { status: 'success' }
          }
        }
      }
    }
  })

  assert.equal(result.status, 'published')
  assert.deepEqual(result.forgottenHashes, ['older-item-hash'])
  assert.equal(result.forgetResult?.itemHash, 'forget-hash')

  const postWrites = calls.filter(
    ({ url, init }) => String(url).includes('/api/v0/messages') && init?.method === 'POST'
  )
  assert.equal(postWrites.length, 2)

  const forgetEnvelope = JSON.parse(String(postWrites[1].init?.body)) as {
    message?: { type?: string; item_content?: string }
  }
  assert.equal(forgetEnvelope.message?.type, 'FORGET')

  const forgetContent = JSON.parse(String(forgetEnvelope.message?.item_content)) as {
    hashes?: string[]
  }
  assert.deepEqual(forgetContent.hashes, ['older-item-hash'])
})

test('publishRelayBootstrapRegistration can emit dual-key authorization and relay proof metadata', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []

  const result = await publishRelayBootstrapRegistration({
    sender: '0xpublisher',
    signer: async () => 'outer-signed',
    ownerAddress: '0xowner',
    publisherAddress: '0xpublisher',
    ownerSigner: async () => 'owner-auth-signed',
    publisherSigner: async () => 'publisher-proof-signed',
    hasher: async () => 'hash-dual',
    peerId: '12D3KooWPublic',
    registrationId: 'relay:orbitdb-relay-pinner:demo',
    profile: 'orbitdb-relay-pinner',
    version: '0.4.0',
    multiaddrs: ['/ip4/203.0.113.10/tcp/9095/p2p/12D3KooWPublic'],
    browserMultiaddrs: ['/dns4/relay.example.com/tcp/443/tls/ws/p2p/12D3KooWPublic'],
    now: 1234,
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
  assert.equal(calls.length, 1)

  const body = JSON.parse(String(calls[0].init?.body)) as {
    message?: { item_content?: string }
  }
  const itemContent = JSON.parse(String(body.message?.item_content)) as {
    address?: string
    content?: {
      ownerAddress?: string
      publisherAddress?: string
      authorization?: { signature?: string; payload?: { ownerAddress?: string; publisherAddress?: string } }
      relayProof?: { signature?: string; payload?: { peerId?: string } }
    }
  }

  assert.equal(itemContent.address, '0xpublisher')
  assert.equal(itemContent.content?.ownerAddress, '0xowner')
  assert.equal(itemContent.content?.publisherAddress, '0xpublisher')
  assert.equal(itemContent.content?.authorization?.signature, '0xowner-auth-signed')
  assert.equal(itemContent.content?.authorization?.payload?.ownerAddress, '0xowner')
  assert.equal(itemContent.content?.authorization?.payload?.publisherAddress, '0xpublisher')
  assert.equal(itemContent.content?.relayProof?.signature, '0xpublisher-proof-signed')
  assert.equal(itemContent.content?.relayProof?.payload?.peerId, '12D3KooWPublic')
})

test('waitForRelayBootstrapRegistration observes the current registration once it appears', async () => {
  let pageFetches = 0

  const visible = await waitForRelayBootstrapRegistration({
    sender: '0xabc',
    registrationId: 'relay:uc-go-peer:demo',
    peerId: '12D3KooWVisible',
    attempts: 3,
    delayMs: 0,
    fetch: async () => {
      pageFetches += 1
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            posts:
              pageFetches < 2
                ? []
                : [
                    {
                      item_hash: 'visible-hash',
                      address: '0xAbC',
                      ref: 'simple-todo-bootstrap',
                      type: 'relay-bootstrap',
                      content: {
                        peerId: '12D3KooWVisible',
                        registrationId: 'relay:uc-go-peer:demo',
                        multiaddrs: ['/ip4/203.0.113.10/tcp/9095/p2p/12D3KooWVisible'],
                        browserMultiaddrs: ['/dns4/relay.example.com/tcp/443/tls/ws/p2p/12D3KooWVisible'],
                        updatedAt: Date.now(),
                      },
                    },
                  ],
          }
        },
      }
    },
  })

  assert.deepEqual(visible, {
    itemHash: 'visible-hash',
    hash: null,
    registrationId: 'relay:uc-go-peer:demo',
    peerId: '12D3KooWVisible',
    multiaddrs: ['/ip4/203.0.113.10/tcp/9095/p2p/12D3KooWVisible'],
    browserMultiaddrs: ['/dns4/relay.example.com/tcp/443/tls/ws/p2p/12D3KooWVisible'],
  })
})
