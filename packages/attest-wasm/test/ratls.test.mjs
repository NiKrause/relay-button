import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, X509Certificate } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import net from 'node:net'
import tls from 'node:tls'

import { Wallet, verifyMessage } from 'ethers'

import { attestGuest, canonicalSecretsJson, injectSecrets, parseResponse } from '../js/ratls.mjs'

const require = createRequire(import.meta.url)
const wasm = require('../pkg-node/relay_button_attest.js')

// testdata/ratls is written by `cargo test write_ratls_fixture -- --ignored`
// (see the wasm:test script): a certificate whose report binds its key.
const dir = new URL('../testdata/ratls/', import.meta.url)
const cert = await readFile(new URL('cert.pem', dir), 'utf8')
const key = await readFile(new URL('key.pem', dir), 'utf8')
const report = Buffer.from((await readFile(new URL('report.hex', dir), 'utf8')).trim(), 'hex')
const spki = new X509Certificate(cert).publicKey.export({ format: 'der', type: 'spki' })
const servedKey = spki.subarray(spki.length - 65) // the uncompressed P-256 point
const measurement = report.subarray(0x90, 0xc0).toString('hex')
const owner = Wallet.createRandom()

const sha = (algorithm, ...parts) => {
  const hash = createHash(algorithm)
  for (const part of parts) hash.update(part)
  return hash.digest()
}

/** A stand-in for aleph-attest-agent: fresh reports and the owner-checked injection. */
async function agent({ freshNonceOverride, ownerAddress = owner.address } = {}) {
  const injected = []
  const server = tls.createServer({ cert, key }, (socket) => {
    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      const request = parseRequest(buffer)
      if (!request) return
      buffer = Buffer.alloc(0)
      const respond = (status, body) => {
        const payload = Buffer.from(JSON.stringify(body))
        socket.write(`HTTP/1.1 ${status} OK\r\ncontent-type: application/json\r\ncontent-length: ${payload.length}\r\n\r\n`)
        socket.write(payload)
      }
      if (request.path.startsWith('/.well-known/attestation?nonce=')) {
        const nonce = Buffer.from(freshNonceOverride ?? request.path.split('=')[1], 'hex')
        const fresh = Buffer.from(report)
        sha('sha384', Buffer.from('aleph-attest-fresh-v1\0'), servedKey, nonce).copy(fresh, 0x50)
        fresh.fill(0, 0x50 + 48, 0x50 + 64)
        respond(200, { tee_type: 'sev-snp', data: fresh.toString('hex') })
      } else if (request.method === 'POST' && request.path === '/confidential/inject-secret') {
        const { secrets, signature } = JSON.parse(request.body)
        const canonical = canonicalSecretsJson(secrets)
        const payload = `aleph-snp-inject-secret-v1|${sha('sha384', servedKey).toString('hex')}|${sha('sha256', canonical).toString('hex')}`
        if (verifyMessage(payload, signature).toLowerCase() !== ownerAddress.toLowerCase()) return respond(403, { error: 'not the owner' })
        injected.push(...Object.keys(secrets))
        respond(200, { injected: Object.keys(secrets) })
      } else {
        respond(404, {})
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { port: server.address().port, injected, close: () => server.close() }
}

function parseRequest(buffer) {
  const text = buffer.toString()
  const end = text.indexOf('\r\n\r\n')
  if (end < 0) return null
  const [line, ...headers] = text.slice(0, end).split('\r\n')
  const [method, path] = line.split(' ')
  const length = Number(headers.find((h) => h.toLowerCase().startsWith('content-length:'))?.split(':')[1] ?? 0)
  const body = buffer.subarray(Buffer.byteLength(text.slice(0, end + 4)))
  if (body.length < length) return null
  return { method, path, body: body.subarray(0, length).toString() }
}

/** The transport the browser gets from a WebSocket relay, here a plain TCP socket. */
function tcpTransport(port) {
  const socket = net.connect(port, '127.0.0.1')
  return {
    opened: new Promise((resolve, reject) => socket.once('connect', resolve).once('error', reject)),
    send: (bytes) => socket.write(bytes),
    onData: (callback) => socket.on('data', (chunk) => callback(new Uint8Array(chunk))),
    onClose: (callback) => socket.on('close', callback),
    close: () => socket.destroy(),
  }
}

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
