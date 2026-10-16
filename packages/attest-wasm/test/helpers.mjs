// Shared by the RA-TLS tests: the fixture certificate and a stand-in for
// aleph-attest-agent (fresh reports, owner-checked injection).
import { createHash, X509Certificate } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import net from 'node:net'
import tls from 'node:tls'

import { Wallet, verifyMessage } from 'ethers'

import { canonicalSecretsJson } from '../js/ratls.mjs'

// testdata/ratls is written by `cargo test write_ratls_fixture -- --ignored`
// (see the wasm:test script): a certificate whose report binds its key.
const dir = new URL('../testdata/ratls/', import.meta.url)
export const cert = await readFile(new URL('cert.pem', dir), 'utf8')
export const key = await readFile(new URL('key.pem', dir), 'utf8')
export const report = Buffer.from((await readFile(new URL('report.hex', dir), 'utf8')).trim(), 'hex')
const spki = new X509Certificate(cert).publicKey.export({ format: 'der', type: 'spki' })
export const servedKey = spki.subarray(spki.length - 65) // the uncompressed P-256 point
export const measurement = report.subarray(0x90, 0xc0).toString('hex')
export const owner = Wallet.createRandom()

const sha = (algorithm, ...parts) => {
  const hash = createHash(algorithm)
  for (const part of parts) hash.update(part)
  return hash.digest()
}

/** A stand-in for aleph-attest-agent: fresh reports and the owner-checked injection. */
export async function agent({ freshNonceOverride, ownerAddress = owner.address } = {}) {
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
export function tcpTransport(port) {
  const socket = net.connect(port, '127.0.0.1')
  return {
    opened: new Promise((resolve, reject) => socket.once('connect', resolve).once('error', reject)),
    send: (bytes) => socket.write(bytes),
    onData: (callback) => socket.on('data', (chunk) => callback(new Uint8Array(chunk))),
    onClose: (callback) => socket.on('close', callback),
    close: () => socket.destroy(),
  }
}

