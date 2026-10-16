// RA-TLS to an SEV-SNP guest from the browser (relay-button#169, step 2).
//
// The TLS client runs in WASM (RaTlsSession); this file carries its records
// over a transport (a WebSocket to a TCP relay in the browser), speaks a
// minimal HTTP/1.1 over the attested channel, and implements aleph-rs's
// fresh_attestation and secret injection on top:
//
//   attestGuest: handshake (report bound to the TLS key, pins checked)
//     -> full AMD verification of the certificate report
//     -> GET /.well-known/attestation?nonce=… over the same channel
//     -> full AMD verification of the fresh report
//     -> the fresh report binds this TLS key and the nonce.
//   injectSecrets: the owner signs (personal_sign) the payload binding the
//     attested key and the secrets, then POST /confidential/inject-secret.
//
// Only the nonce is sent before the attestation holds; the secrets only after.

import { verifyAttestation } from './index.mjs'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
const fromHex = (text) => Uint8Array.from(text.match(/../g) ?? [], (pair) => parseInt(pair, 16))

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

/**
 * A transport over a browser WebSocket to a relay that forwards bytes to the
 * guest's attestation port. The relay sees TLS records only.
 */
export function websocketTransport(url, { WebSocketImpl = globalThis.WebSocket } = {}) {
  const socket = new WebSocketImpl(url)
  socket.binaryType = 'arraybuffer'
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true })
    socket.addEventListener('error', () => reject(new Error(`WebSocket to ${url} failed`)), { once: true })
  })
  return {
    opened,
    send: (bytes) => socket.send(bytes),
    onData: (callback) => socket.addEventListener('message', (event) => callback(new Uint8Array(event.data))),
    onClose: (callback) => socket.addEventListener('close', () => callback()),
    close: () => socket.close(),
  }
}

/**
 * Open a TLS session to the guest over `transport` and complete the attested
 * handshake. Resolves to a channel with `request()`; rejects with the reason
 * if the certificate's report is not bound to its key or misses the pins.
 */
export async function openAttestedChannel({ wasm, transport, expectedMeasurements, expectedPolicy, timeoutMs = 30_000 }) {
  const session = new wasm.RaTlsSession(expectedMeasurements, expectedPolicy == null ? null : String(expectedPolicy))
  let plaintext = new Uint8Array(0)
  let failure = null
  let closed = false
  const waiters = new Set()
  const wake = () => {
    for (const waiter of waiters) waiter()
  }

  const flush = () => {
    const out = session.takeOutgoing()
    if (out.length > 0) transport.send(out)
  }

  transport.onData((bytes) => {
    try {
      session.pushIncoming(bytes)
      flush()
      const more = session.isHandshaking() ? new Uint8Array(0) : session.takePlaintext()
      if (more.length > 0) plaintext = concat(plaintext, more)
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error))
      transport.close()
    }
    wake()
  })
  transport.onClose(() => {
    closed = true
    wake()
  })

  const until = (predicate, what) =>
    new Promise((resolve, reject) => {
      const deadline = setTimeout(() => {
        waiters.delete(check)
        reject(new Error(`timed out waiting for ${what}`))
      }, timeoutMs)
      const check = () => {
        if (failure) {
          clearTimeout(deadline)
          waiters.delete(check)
          reject(failure)
        } else if (predicate()) {
          clearTimeout(deadline)
          waiters.delete(check)
          resolve()
        } else if (closed) {
          clearTimeout(deadline)
          waiters.delete(check)
          reject(new Error(`the connection closed while waiting for ${what}`))
        }
      }
      waiters.add(check)
      check()
    })

  if (transport.opened) await transport.opened
  flush()
  await until(() => !session.isHandshaking(), 'the attested TLS handshake')

  /** One HTTP/1.1 exchange over the attested channel. */
  const request = async (method, path, { headers = {}, body } = {}) => {
    const payload = body == null ? new Uint8Array(0) : typeof body === 'string' ? encoder.encode(body) : body
    const lines = [`${method} ${path} HTTP/1.1`, 'host: attestation.aleph.invalid', `content-length: ${payload.length}`]
    for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`)
    plaintext = new Uint8Array(0)
    session.writePlaintext(concat(encoder.encode(`${lines.join('\r\n')}\r\n\r\n`), payload))
    flush()
    let response = null
    await until(() => (response = parseResponse(plaintext)) !== null, `the answer to ${method} ${path}`)
    plaintext = new Uint8Array(0)
    return response
  }

  return {
    session,
    request,
    certReport: session.certReport(),
    servedPublicKey: session.servedPublicKey(),
    close: () => {
      session.close()
      try {
        flush()
      } catch {}
      transport.close()
    },
  }
}

/** A complete HTTP/1.1 response in `bytes`, or null if more is needed. */
export function parseResponse(bytes) {
  const text = decoder.decode(bytes)
  const end = text.indexOf('\r\n\r\n')
  if (end < 0) return null
  const [statusLine, ...headerLines] = text.slice(0, end).split('\r\n')
  const status = Number(statusLine.split(' ')[1])
  const headers = {}
  for (const line of headerLines) {
    const colon = line.indexOf(':')
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
  }
  const head = encoder.encode(text.slice(0, end + 4)).length
  const rest = bytes.slice(head)
  if (headers['transfer-encoding']?.toLowerCase() === 'chunked') {
    const chunks = []
    let offset = 0
    for (;;) {
      const lineEnd = decoder.decode(rest.slice(offset)).indexOf('\r\n')
      if (lineEnd < 0) return null
      const size = parseInt(decoder.decode(rest.slice(offset, offset + lineEnd)), 16)
      offset += lineEnd + 2
      if (size === 0) break
      if (rest.length < offset + size + 2) return null
      chunks.push(rest.slice(offset, offset + size))
      offset += size + 2
    }
    return { status, headers, body: chunks.reduce(concat, new Uint8Array(0)) }
  }
  const length = Number(headers['content-length'] ?? 0)
  if (rest.length < length) return null
  return { status, headers, body: rest.slice(0, length) }
}

/**
 * aleph-rs fresh_attestation, in the browser: an attested channel to the
 * guest whose key a fresh, fully verified report binds to a nonce of ours.
 *
 * `verify` defaults to verifyAttestation (AMD KDS + WASM); tests replace it.
 */
export async function attestGuest({
  wasm,
  transport,
  product,
  expectedMeasurements,
  expectedPolicy,
  minTcb,
  fetch,
  verify = verifyAttestation,
  nonce = globalThis.crypto.getRandomValues(new Uint8Array(32)),
  timeoutMs,
}) {
  const channel = await openAttestedChannel({ wasm, transport, expectedMeasurements, expectedPolicy, timeoutMs })
  try {
    const check = (report) => verify({ wasm, report, product, expectedMeasurements, expectedPolicy, minTcb, fetch })
    const certVerified = await check(channel.certReport)

    const response = await channel.request('GET', `/.well-known/attestation?nonce=${hex(nonce)}`)
    if (response.status !== 200) throw new Error(`the guest answered ${response.status} to the freshness challenge`)
    const dto = JSON.parse(decoder.decode(response.body))
    if (dto.tee_type !== 'sev-snp') throw new Error(`the fresh report is ${dto.tee_type}, not sev-snp`)
    const freshReport = fromHex(String(dto.data ?? ''))
    const freshVerified = await check(freshReport)
    wasm.verifyFreshBinding(freshReport, channel.servedPublicKey, nonce)

    return { channel, servedPublicKey: channel.servedPublicKey, certVerified, freshVerified }
  } catch (error) {
    channel.close()
    throw error
  }
}

/** serde_json's serialization of a BTreeMap<String, String>: sorted keys, compact. */
export function canonicalSecretsJson(secrets) {
  const sorted = {}
  for (const key of Object.keys(secrets).sort()) sorted[key] = String(secrets[key])
  return JSON.stringify(sorted)
}

/**
 * Unlock: the instance owner signs the payload that binds the attested key
 * and these secrets (`sign` is EIP-191 personal_sign, e.g. MetaMask), and the
 * secrets go over the attested channel.
 */
export async function injectSecrets({ wasm, attested, secrets, sign }) {
  const canonical = canonicalSecretsJson(secrets)
  const payload = wasm.injectSecretPayload(attested.servedPublicKey, canonical)
  const signature = await sign(payload)
  const response = await attested.channel.request('POST', '/confidential/inject-secret', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secrets: JSON.parse(canonical), signature }),
  })
  const text = decoder.decode(response.body)
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`the guest refused the secrets (${response.status}): ${text}`)
  }
  return JSON.parse(text)
}
