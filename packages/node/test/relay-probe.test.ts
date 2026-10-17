import test from 'node:test'
import assert from 'node:assert/strict'

import { multiaddr } from '@multiformats/multiaddr'

import {
  classifyRelayAddress,
  multiaddrProtocols,
  relayProbePolicyFromEnv,
  targetPeerId,
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
