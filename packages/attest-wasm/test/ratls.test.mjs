import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import http from 'node:http'

import { Wallet } from 'ethers'

import { agent, measurement, owner, servedKey, tcpTransport } from './helpers.mjs'

import { attachAttestRelay } from '@le-space/attest-relay'

import { attestGuest, canonicalSecretsJson, injectSecrets, parseResponse, websocketTransport } from '../js/ratls.mjs'

const require = createRequire(import.meta.url)
const wasm = require('../pkg-node/relay_button_attest.js')

// The AMD chain is verifyAttestation's (tested in wasm.test.mjs); here it is a
// stand-in, so this file tests the channel, the freshness and the injection.
const calls = []
const verify = async ({ report: checked, expectedMeasurements }) => {
  calls.push(Buffer.from(checked).subarray(0x50, 0x50 + 48).toString('hex'))
  assert.deepEqual(expectedMeasurements, [measurement])
  return { verified: true, measurement }
}

test('attests the guest, then unlocks it with an owner-signed injection', async () => {
  const guest = await agent()
  calls.length = 0
  const attested = await attestGuest({ wasm, transport: tcpTransport(guest.port), product: 'Milan', expectedMeasurements: [measurement], verify })
  assert.deepEqual(Buffer.from(attested.servedPublicKey), servedKey)
  assert.equal(calls.length, 2, 'the certificate report and the fresh report are both verified')
  assert.notEqual(calls[0], calls[1])

  const result = await injectSecrets({ wasm, attested, secrets: { luks_passphrase: 'correct horse' }, sign: (payload) => owner.signMessage(payload) })
  assert.deepEqual(result, { injected: ['luks_passphrase'] })
  assert.deepEqual(guest.injected, ['luks_passphrase'])
  attested.channel.close()
  guest.close()
})

test('a fresh report bound to another nonce is refused', async () => {
  const guest = await agent({ freshNonceOverride: '00'.repeat(32) })
  await assert.rejects(
    attestGuest({ wasm, transport: tcpTransport(guest.port), product: 'Milan', expectedMeasurements: [measurement], verify }),
    /does not bind this TLS key and nonce/,
  )
  guest.close()
})

test('a measurement the message did not pin ends the handshake', async () => {
  const guest = await agent()
  await assert.rejects(
    attestGuest({ wasm, transport: tcpTransport(guest.port), product: 'Milan', expectedMeasurements: ['11'.repeat(48)], verify }),
    /attestation rejected during the RA-TLS handshake: measurement/,
  )
  guest.close()
})

test('a signature by someone other than the owner is refused by the guest', async () => {
  const guest = await agent({ ownerAddress: Wallet.createRandom().address })
  const attested = await attestGuest({ wasm, transport: tcpTransport(guest.port), product: 'Milan', expectedMeasurements: [measurement], verify })
  await assert.rejects(
    injectSecrets({ wasm, attested, secrets: { luks_passphrase: 'x' }, sign: (payload) => owner.signMessage(payload) }),
    /refused the secrets \(403\)/,
  )
  attested.channel.close()
  guest.close()
})

test('parseResponse handles content-length and chunked bodies', () => {
  const enc = new TextEncoder()
  assert.equal(parseResponse(enc.encode('HTTP/1.1 200 OK\r\ncontent-length: 5\r\n\r\nhel')), null)
  assert.equal(new TextDecoder().decode(parseResponse(enc.encode('HTTP/1.1 200 OK\r\ncontent-length: 5\r\n\r\nhello')).body), 'hello')
  const chunked = parseResponse(enc.encode('HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n'))
  assert.equal(new TextDecoder().decode(chunked.body), 'abcde')
  assert.equal(canonicalSecretsJson({ b: '2', a: '1' }), '{"a":"1","b":"2"}')
})

test('the browser path: WebSocket through the attest relay to the guest, then unlock', async () => {
  const guest = await agent()
  const server = http.createServer()
  const resolved = []
  const relay = attachAttestRelay(server, {
    allowPrivateTargets: true, // the stand-in listens on loopback
    resolveTarget: async (crn, vm) => (resolved.push([crn, vm]), { host: '127.0.0.1', port: guest.port }),
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const crn = 'c'.repeat(64)
  const vm = 'a'.repeat(64)
  const transport = websocketTransport(`ws://127.0.0.1:${server.address().port}/attest?crn=${crn}&vm=${vm}`)

  const attested = await attestGuest({ wasm, transport, product: 'Milan', expectedMeasurements: [measurement], verify })
  const result = await injectSecrets({ wasm, attested, secrets: { luks_passphrase: 'through the relay' }, sign: (payload) => owner.signMessage(payload) })
  assert.deepEqual(result, { injected: ['luks_passphrase'] })
  assert.deepEqual(resolved, [[crn, vm]])

  attested.channel.close()
  relay.close()
  server.closeAllConnections()
  server.close()
  guest.close()
})
