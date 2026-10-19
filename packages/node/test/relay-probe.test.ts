import test from 'node:test'
import assert from 'node:assert/strict'

import { multiaddr } from '@multiformats/multiaddr'

import {
  classifyRelayAddress,
  hostHasGlobalIpv6,
  multiaddrProtocols,
  probeRelayAddress,
  quicSubstituteFor,
  relayProbePolicyFromEnv,
  targetPeerId,
  transportOf,
} from '../src/relay-probe.ts'
import { deriveLibp2pSecp256k1IdentityFromEvmKey } from '../src/relay-identity.ts'

// The relay probe decides whether a deployed relay counts as healthy. Moving it
// from libp2p 2 to libp2p 3 meant moving from multiaddr 12 to 13, which removed
// `protoNames()` and `getPeerId()`. These tests pin the replacements to what
// those methods returned; the expected values were checked against
// multiaddr 12 on 31 addresses taken from live relay registrations.

const RELAY = '16Uiu2HAmD1icgrT9rUCbxsd7fEygKPxejXgmRGod5PjtRuQvEpVC'
const TARGET = '12D3KooWEhT5TfVhM8oj5fsNyGs5LaLGmfyreoyDsc9bjU3ANP1a'
const CERTHASH_A = 'uEiAfeGD_BY5VWW1FB98alpOB_j9YEz8oCJGM9KbFusg1mA'
const CERTHASH_B = 'uEiDoFuUjReB6kJaVC9_e10dHm__ARYH62B9C6abQ6oCcTw'

const ADDRESSES = {
  tcp: `/ip4/62.141.40.252/tcp/63484/p2p/${RELAY}`,
  autotlsWss: `/dns4/191-96-166-44.k51qzi5uqu5dhznosr1j4xs2h2slf8wzqcibrgt4ifu7sva81dfv5zkqdhgff5.libp2p.direct/tcp/24686/tls/ws/p2p/${TARGET}`,
  sniWss: `/ip4/62.141.40.252/tcp/64861/tls/sni/62-141-40-252.k51qzi5uqu5dhznosr1j4xs2h2slf8wzqcibrgt4ifu7sva81dfv5zkqdhgff5.libp2p.direct/ws/p2p/${RELAY}`,
  proxyWss: `/dns4/dose-multiply-mass-maximum.2n6.me/tcp/443/tls/ws/p2p/${RELAY}`,
  webtransport: `/ip4/62.141.40.252/udp/63485/quic-v1/webtransport/certhash/${CERTHASH_A}/certhash/${CERTHASH_B}/p2p/${RELAY}`,
  webrtcDirect: `/ip4/62.141.40.252/udp/63485/webrtc-direct/certhash/${CERTHASH_A}/p2p/${RELAY}`,
  quic: `/ip4/62.141.40.252/udp/63485/quic-v1/p2p/${RELAY}`,
}

test('multiaddrProtocols returns the protocol names in order, as protoNames() did', () => {
  assert.deepEqual(multiaddrProtocols(multiaddr(ADDRESSES.tcp)), ['ip4', 'tcp', 'p2p'])
  assert.deepEqual(multiaddrProtocols(multiaddr(ADDRESSES.autotlsWss)), ['dns4', 'tcp', 'tls', 'ws', 'p2p'])
  assert.deepEqual(multiaddrProtocols(multiaddr(ADDRESSES.sniWss)), ['ip4', 'tcp', 'tls', 'sni', 'ws', 'p2p'])
  assert.deepEqual(multiaddrProtocols(multiaddr(ADDRESSES.webtransport)), [
    'ip4', 'udp', 'quic-v1', 'webtransport', 'certhash', 'certhash', 'p2p',
  ])
  assert.deepEqual(multiaddrProtocols(multiaddr(ADDRESSES.webrtcDirect)), [
    'ip4', 'udp', 'webrtc-direct', 'certhash', 'p2p',
  ])
})

test('targetPeerId returns the peer an ordinary address dials', () => {
  assert.equal(targetPeerId(multiaddr(ADDRESSES.tcp))?.toString(), RELAY)
  assert.equal(targetPeerId(multiaddr(ADDRESSES.autotlsWss))?.toString(), TARGET)
})

test('targetPeerId returns the target of a relayed address, not the relay', () => {
  const relayed = multiaddr(`${ADDRESSES.proxyWss}/p2p-circuit/p2p/${TARGET}`)
  assert.equal(targetPeerId(relayed)?.toString(), TARGET)
})

test('targetPeerId returns null for a relayed address without a target', () => {
  assert.equal(targetPeerId(multiaddr(`${ADDRESSES.proxyWss}/p2p-circuit`)), null)
})

test('targetPeerId returns null when there is no peer id or it cannot be parsed', () => {
  assert.equal(targetPeerId(multiaddr('/ip4/1.2.3.4/tcp/4001')), null)
  assert.equal(targetPeerId(multiaddr('/ip4/1.2.3.4/tcp/4001/p2p/not-a-peer-id')), null)
})

test('classifyRelayAddress assigns each transport its probe family', () => {
  const policy = relayProbePolicyFromEnv({})
  const family = (address: string) =>
    classifyRelayAddress(address, multiaddrProtocols(multiaddr(address)), policy).family

  assert.equal(family(ADDRESSES.tcp), 'tcp')
  assert.equal(family(ADDRESSES.autotlsWss), 'direct-wss')
  assert.equal(family(ADDRESSES.sniWss), 'direct-wss')
  assert.equal(family(ADDRESSES.proxyWss), 'proxy-wss')
  assert.equal(family(ADDRESSES.webtransport), 'webtransport')
  assert.equal(family(ADDRESSES.webrtcDirect), 'webrtc-direct')
  assert.equal(family(ADDRESSES.quic), 'other')
})

// A relay's peer id is derived from its EVM key. If moving @libp2p/crypto and
// @libp2p/peer-id to new majors changed that derivation, every relay would
// silently come back with a different identity. The expected values were
// computed with the libp2p 2 stack, before the move.
test('a relay derives the same libp2p identity from its EVM key as before', () => {
  // Hardhat's first well-known development key; not a secret.
  const identity = deriveLibp2pSecp256k1IdentityFromEvmKey(
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  )
  assert.equal(identity.peerId, '16Uiu2HAmMUjGmiUhJeiZgu6ZZnLRkE2VViR2JgjqtW9aTZnHQqgg')
  assert.equal(identity.protobufBase64, 'CAISIKwJdL7Dmhfja6SmtNI4/5RLrLR4y+1e/K54TXv08v+A')
})

test('transportOf reduces an address to the transport it runs over', () => {
  const of = (address: string) => transportOf(multiaddrProtocols(multiaddr(address)))
  assert.equal(of(ADDRESSES.tcp), 'tcp')
  assert.equal(of(ADDRESSES.autotlsWss), 'ws')
  assert.equal(of(ADDRESSES.sniWss), 'ws')
  assert.equal(of(ADDRESSES.proxyWss), 'ws')
  assert.equal(of(ADDRESSES.webtransport), 'webtransport')
  assert.equal(of(ADDRESSES.webrtcDirect), 'webrtc-direct')
  assert.equal(of(ADDRESSES.quic), 'quic')
})

test('quicSubstituteFor drops webtransport and its certhashes, keeping the QUIC listener', () => {
  assert.equal(
    quicSubstituteFor(multiaddr(ADDRESSES.webtransport))?.toString(),
    `/ip4/62.141.40.252/udp/63485/quic-v1/p2p/${RELAY}`,
  )
  assert.equal(quicSubstituteFor(multiaddr(ADDRESSES.tcp)), null)
  assert.equal(quicSubstituteFor(multiaddr(ADDRESSES.webrtcDirect)), null)
})

// A stand-in for a libp2p node with the one behaviour #187 is about: dial()
// returns an existing connection to the same peer instead of opening a new one
// over the requested transport. `hangUpWorks: false` reproduces the old probe.
function fakeNode({ hangUpWorks = true } = {}) {
  const connections = new Map<string, { remoteAddr: ReturnType<typeof multiaddr> }>()
  const calls: string[] = []
  const peerOf = (ma: ReturnType<typeof multiaddr>) => targetPeerId(ma)?.toString() ?? ''
  return {
    calls,
    node: {
      async hangUp(peer: { toString(): string }) {
        calls.push(`hangUp ${peer.toString().slice(-4)}`)
        if (hangUpWorks) connections.delete(peer.toString())
      },
      async dial(ma: ReturnType<typeof multiaddr>) {
        calls.push(`dial ${transportOf(multiaddrProtocols(ma))}`)
        const peer = peerOf(ma)
        const existing = connections.get(peer)
        if (existing) return existing
        const connection = { remoteAddr: ma }
        connections.set(peer, connection)
        return connection
      },
      getConnections(peer: { toString(): string }) {
        const connection = connections.get(peer.toString())
        return connection ? [connection] : []
      },
      services: { ping: { async ping() { return 3 } } },
    },
  }
}

const POLICY = relayProbePolicyFromEnv({ PROBE_SETTLE_MS: '0', PROBE_TIMEOUT_MS: '1000', PROBE_IPV6: 'true' })

test('each address is dialed over its own transport, not over the previous connection', async () => {
  const { node, calls } = fakeNode()
  const first = await probeRelayAddress(node as never, ADDRESSES.tcp, POLICY)
  const second = await probeRelayAddress(node as never, ADDRESSES.proxyWss, POLICY)

  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.deepEqual(second.remoteAddrs, [ADDRESSES.proxyWss])
  // Close before each dial, and again afterwards so nothing is left to reuse.
  const hangUp = `hangUp ${RELAY.slice(-4)}`
  assert.deepEqual(calls, [hangUp, 'dial tcp', hangUp, hangUp, 'dial ws', hangUp])
})

test('a connection over a different transport than requested fails the address', async () => {
  // The old behaviour: nothing closes the first connection, so the second
  // dial gets it back. This must no longer pass as a proxy-wss success.
  const { node } = fakeNode({ hangUpWorks: false })
  await probeRelayAddress(node as never, ADDRESSES.tcp, POLICY)
  const second = await probeRelayAddress(node as never, ADDRESSES.proxyWss, POLICY)

  assert.equal(second.ok, false)
  assert.match(second.error ?? '', /dial returned a tcp connection .* instead of ws/)
})

test('a webtransport address is checked over QUIC on the same port, and says so', async () => {
  const { node, calls } = fakeNode()
  const result = await probeRelayAddress(node as never, ADDRESSES.webtransport, POLICY)

  assert.equal(result.ok, true)
  assert.equal(result.family, 'webtransport')
  assert.ok(calls.includes('dial quic'), `expected a QUIC dial, got ${calls.join(', ')}`)
  assert.match(result.note ?? '', /checked over libp2p QUIC on the same UDP port/)
  assert.match(result.note ?? '', /HTTP\/3 layer and the certhash are not/)
})

const IPV6_TCP = `/ip6/2001:db8::10/tcp/63484/p2p/${RELAY}`

test('hostHasGlobalIpv6 ignores loopback, link-local and unique-local addresses', () => {
  const entry = (address: string, internal = false) =>
    ({ address, family: 'IPv6', internal, netmask: '', mac: '', cidr: null, scopeid: 0 }) as never
  assert.equal(hostHasGlobalIpv6({ lo0: [entry('::1', true)], en0: [entry('fe80::1'), entry('fd00::5')] }), false)
  assert.equal(hostHasGlobalIpv6({ en0: [entry('fe80::1'), entry('2001:db8::7')] }), true)
  assert.equal(hostHasGlobalIpv6({}), false)
})

test('without IPv6 on the probing host an IPv6 address is reported as not checked, not as failed', async () => {
  const { node, calls } = fakeNode()
  const policy = relayProbePolicyFromEnv({ PROBE_SETTLE_MS: '0', PROBE_IPV6: 'false' })
  const result = await probeRelayAddress(node as never, IPV6_TCP, policy)

  assert.deepEqual(calls, [], 'nothing should be dialed')
  assert.equal(result.ok, false)
  assert.equal(result.required, false, 'an unchecked address cannot fail the deploy')
  assert.match(result.note ?? '', /not checked: the probing host has no global IPv6/)
})

test('with IPv6 on the probing host an IPv6 address is dialed like any other', async () => {
  const { node, calls } = fakeNode()
  const result = await probeRelayAddress(node as never, IPV6_TCP, POLICY)

  assert.ok(calls.includes('dial tcp'))
  assert.equal(result.ok, true)
  assert.equal(result.note, null)
})
