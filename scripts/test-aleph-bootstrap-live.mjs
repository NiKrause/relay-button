import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'

import {
  DEFAULT_ALEPH_API_HOST,
  DEFAULT_ALEPH_BOOTSTRAP_CHANNEL,
  DEFAULT_ALEPH_BOOTSTRAP_POST_TYPE,
  discoverAlephBootstrapMultiaddrs,
  fetchAlephBootstrapPosts
} from '../packages/aleph-bootstrap/src/index.ts'
import { publishRelayBootstrapRegistration } from '../packages/core/src/bootstrap-registration.ts'
import { createPrivateKeyIdentity } from '../packages/node/src/signer.ts'

function requireEnv(name, fallback) {
  const value = process.env[name] ?? fallback
  if (typeof value === 'string' && value.trim()) return value.trim()
  throw new Error(`Missing required environment variable: ${name}`)
}

function parseList(value, fallback) {
  const source = typeof value === 'string' && value.trim() ? value : fallback
  return source
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function deriveEphemeralPrivateKey() {
  return `0x${randomBytes(32).toString('hex')}`
}

async function main() {
  const useEphemeralKey =
    (process.env.ALEPH_BOOTSTRAP_TEST_USE_EPHEMERAL_KEY ?? '').trim().toLowerCase() ===
    'true'
  const privateKey = useEphemeralKey
    ? deriveEphemeralPrivateKey()
    : requireEnv(
        'ALEPH_BOOTSTRAP_TEST_PRIVATE_KEY',
        process.env.ALEPH_PRIVATE_KEY
      )
  const apiHost = process.env.ALEPH_BOOTSTRAP_TEST_API_HOST ?? DEFAULT_ALEPH_API_HOST
  const channel =
    process.env.ALEPH_BOOTSTRAP_TEST_CHANNEL ?? DEFAULT_ALEPH_BOOTSTRAP_CHANNEL
  const postType =
    process.env.ALEPH_BOOTSTRAP_TEST_POST_TYPE ?? DEFAULT_ALEPH_BOOTSTRAP_POST_TYPE
  const ref =
    process.env.ALEPH_BOOTSTRAP_TEST_REF ??
    `aleph-bootstrap-live-${new Date().toISOString().replace(/[:.]/g, '-')}`
  const peerId =
    process.env.ALEPH_BOOTSTRAP_TEST_PEER_ID ??
    '12D3KooWTestBootstrapPeer111111111111111111111111111'
  const registrationId =
    process.env.ALEPH_BOOTSTRAP_TEST_REGISTRATION_ID ?? `relay:aleph-bootstrap-live:${peerId}`
  const pollAttempts = Number(process.env.ALEPH_BOOTSTRAP_TEST_POLL_ATTEMPTS ?? 12)
  const pollDelayMs = Number(process.env.ALEPH_BOOTSTRAP_TEST_POLL_DELAY_MS ?? 5000)
  const forgetPollAttempts = Number(
    process.env.ALEPH_BOOTSTRAP_TEST_FORGET_POLL_ATTEMPTS ?? pollAttempts
  )
  const forgetPollDelayMs = Number(
    process.env.ALEPH_BOOTSTRAP_TEST_FORGET_POLL_DELAY_MS ?? pollDelayMs
  )

  const publicMultiaddrs = parseList(
    process.env.ALEPH_BOOTSTRAP_TEST_MULTIADDRS,
    `/dns4/bootstrap-test.example/tcp/443/tls/ws/p2p/${peerId},/ip4/203.0.113.42/tcp/9095/p2p/${peerId}`
  )
  const browserMultiaddrs = parseList(
    process.env.ALEPH_BOOTSTRAP_TEST_BROWSER_MULTIADDRS,
    `/dns4/bootstrap-test.example/tcp/443/tls/ws/p2p/${peerId}`
  )
  const localOnlyMultiaddrs = parseList(
    process.env.ALEPH_BOOTSTRAP_TEST_LOCAL_MULTIADDRS,
    `/ip4/127.0.0.1/tcp/4001/p2p/${peerId},/dns4/localhost/tcp/443/tls/ws/p2p/${peerId}`
  )
  const refreshedPublicMultiaddrs = parseList(
    process.env.ALEPH_BOOTSTRAP_TEST_REFRESH_MULTIADDRS,
    `/dns4/bootstrap-test-refresh.example/tcp/443/tls/ws/p2p/${peerId},/ip4/203.0.113.43/tcp/9096/p2p/${peerId}`
  )
  const refreshedBrowserMultiaddrs = parseList(
    process.env.ALEPH_BOOTSTRAP_TEST_REFRESH_BROWSER_MULTIADDRS,
    `/dns4/bootstrap-test-refresh.example/tcp/443/tls/ws/p2p/${peerId}`
  )

  const identity = await createPrivateKeyIdentity(privateKey)
  const hasher = async (payload) =>
    createHash('sha256').update(payload).digest('hex')

  console.log(
    JSON.stringify(
      {
        step: 'publishing',
        apiHost,
        channel,
        ref,
        postType,
        sender: identity.address,
        useEphemeralKey,
        registrationId,
        publicMultiaddrs,
        browserMultiaddrs,
        localOnlyMultiaddrs,
        refreshedPublicMultiaddrs,
        refreshedBrowserMultiaddrs
      },
      null,
      2
    )
  )

  const publication = await publishRelayBootstrapRegistration({
    sender: identity.address,
    signer: identity.signer,
    hasher,
    fetch: globalThis.fetch.bind(globalThis),
    apiHost,
    channel,
    ref,
    postType,
    peerId,
    registrationId,
    profile: 'aleph-bootstrap-live-test',
    version: '0.3.0',
    multiaddrs: [...publicMultiaddrs, ...localOnlyMultiaddrs],
    browserMultiaddrs: [...browserMultiaddrs, ...localOnlyMultiaddrs],
    forgetPrevious: true,
    sync: true
  })

  assert.equal(publication.status, 'published')
  assert.deepEqual(publication.publishedMultiaddrs, publicMultiaddrs)
  assert.deepEqual(publication.publishedBrowserMultiaddrs, browserMultiaddrs)

  async function fetchState() {
    const posts = await fetchAlephBootstrapPosts({
      apiHost,
      channel,
      ref,
      postType,
      fetch: globalThis.fetch.bind(globalThis)
    })
    const discovered = await discoverAlephBootstrapMultiaddrs({
      apiHost,
      channel,
      ref,
      postType,
      fetch: globalThis.fetch.bind(globalThis)
    })
    return { posts, discovered }
  }

  let posts = []
  let discovered = []
  for (let attempt = 1; attempt <= pollAttempts; attempt += 1) {
    ;({ posts, discovered } = await fetchState())

    const foundPost = posts.find((entry) => entry.itemHash === publication.itemHash)
    const foundDiscovery = browserMultiaddrs.every((addr) => discovered.includes(addr))
    console.log(
      JSON.stringify(
        {
          step: 'poll',
          attempt,
          foundPost: Boolean(foundPost),
          discoveredCount: discovered.length,
          discovered
        },
        null,
        2
      )
    )

    if (foundPost && foundDiscovery) break
    if (attempt < pollAttempts) await sleep(pollDelayMs)
  }

  const foundPost = posts.find((entry) => entry.itemHash === publication.itemHash)
  assert.ok(
    foundPost,
    `Did not read back the published bootstrap post after ${pollAttempts} attempts`
  )
  assert.ok(
    browserMultiaddrs.every((addr) => discovered.includes(addr)),
    'Did not discover every published browser bootstrap multiaddr'
  )
  assert.ok(
    localOnlyMultiaddrs.every((addr) => !discovered.includes(addr)),
    'Local-only bootstrap multiaddrs should not survive discovery filtering'
  )

  console.log(
    JSON.stringify(
      {
        step: 'republishing',
        previousItemHash: publication.itemHash,
        previousDiscovered: discovered,
        nextPublicMultiaddrs: refreshedPublicMultiaddrs,
        nextBrowserMultiaddrs: refreshedBrowserMultiaddrs
      },
      null,
      2
    )
  )

  const refreshedPublication = await publishRelayBootstrapRegistration({
    sender: identity.address,
    signer: identity.signer,
    hasher,
    fetch: globalThis.fetch.bind(globalThis),
    apiHost,
    channel,
    ref,
    postType,
    peerId,
    registrationId,
    profile: 'aleph-bootstrap-live-test',
    version: '0.3.0',
    multiaddrs: [...refreshedPublicMultiaddrs, ...localOnlyMultiaddrs],
    browserMultiaddrs: [...refreshedBrowserMultiaddrs, ...localOnlyMultiaddrs],
    forgetPrevious: true,
    sync: true
  })

  assert.equal(refreshedPublication.status, 'published')
  assert.deepEqual(refreshedPublication.publishedMultiaddrs, refreshedPublicMultiaddrs)
  assert.deepEqual(
    refreshedPublication.publishedBrowserMultiaddrs,
    refreshedBrowserMultiaddrs
  )
  assert.ok(
    refreshedPublication.forgottenHashes?.includes(publication.itemHash ?? ''),
    'Republish should request FORGET for the first bootstrap record'
  )

  let finalPosts = []
  let finalDiscovered = []
  let firstHashStillListed = true
  for (let attempt = 1; attempt <= forgetPollAttempts; attempt += 1) {
    ;({ posts: finalPosts, discovered: finalDiscovered } = await fetchState())
    firstHashStillListed = finalPosts.some((entry) => entry.itemHash === publication.itemHash)
    const foundRefreshedPost = finalPosts.find(
      (entry) => entry.itemHash === refreshedPublication.itemHash
    )
    const foundRefreshedDiscovery = refreshedBrowserMultiaddrs.every((addr) =>
      finalDiscovered.includes(addr)
    )
    const oldDiscoveryGone = browserMultiaddrs.every((addr) => !finalDiscovered.includes(addr))

    console.log(
      JSON.stringify(
        {
          step: 'forget-poll',
          attempt,
          foundRefreshedPost: Boolean(foundRefreshedPost),
          firstHashStillListed,
          discoveredCount: finalDiscovered.length,
          discovered: finalDiscovered
        },
        null,
        2
      )
    )

    if (foundRefreshedPost && foundRefreshedDiscovery && oldDiscoveryGone) break
    if (attempt < forgetPollAttempts) await sleep(forgetPollDelayMs)
  }

  const foundRefreshedPost = finalPosts.find(
    (entry) => entry.itemHash === refreshedPublication.itemHash
  )
  assert.ok(
    foundRefreshedPost,
    `Did not read back the refreshed bootstrap post after ${forgetPollAttempts} attempts`
  )
  assert.ok(
    refreshedBrowserMultiaddrs.every((addr) => finalDiscovered.includes(addr)),
    'Did not discover every refreshed browser bootstrap multiaddr'
  )
  assert.ok(
    browserMultiaddrs.every((addr) => !finalDiscovered.includes(addr)),
    'Old browser bootstrap multiaddrs should no longer be selected after republish'
  )
  assert.ok(
    localOnlyMultiaddrs.every((addr) => !finalDiscovered.includes(addr)),
    'Local-only bootstrap multiaddrs should not survive refreshed discovery filtering'
  )

  console.log(
    JSON.stringify(
      {
        step: 'complete',
        initialItemHash: publication.itemHash,
        refreshedItemHash: refreshedPublication.itemHash,
        requestedForgottenHashes: refreshedPublication.forgottenHashes ?? [],
        firstHashStillListedAfterForgetPoll: firstHashStillListed,
        postsFound: finalPosts.length,
        discovered: finalDiscovered
      },
      null,
      2
    )
  )
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error)
  process.exitCode = 1
})
