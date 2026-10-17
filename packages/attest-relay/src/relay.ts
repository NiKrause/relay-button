// WebSocket <-> TCP relay to an SEV-SNP guest's attestation port
// (relay-button#169, step 3).
//
// A browser cannot open the guest's attested TLS port, so the RA-TLS client
// (@le-space/attest-wasm, rustls in WASM) sends its TLS records over a
// WebSocket to this relay, which writes them to the guest and back. The relay
// sees TLS records only: it can drop a connection, never read or change one.
//
// It is not an open proxy. The client names a node and an instance
// (`/attest?crn=<node hash>&vm=<instance hash>`), never a host or port; the
// relay looks up where that instance's port 8443 is mapped on that node, and
// connects only to public addresses: the node's IPv4 mapping, then the
// instance's own IPv6. Each connection is bounded in time
// and bytes, and connections are capped per client address and in total.

import net from 'node:net'
import type { IncomingMessage, Server } from 'node:http'

import { WebSocketServer, type WebSocket } from 'ws'

export const DEFAULT_ALEPH_API_HOST = 'https://api2.aleph.im'
export const CORECHANNEL_ADDRESS = '0xa1B3bb7d2332383D96b7796B908fB7f7F3c2Be10'
/** The port the guest's aleph-attest-agent serves RA-TLS on. */
export const ATTESTATION_PORT = '8443'

const HASH = /^[0-9a-f]{64}$/u

export interface AttestationTarget {
  host: string
  port: number
  /**
   * Tried in order when the target refuses or times out: the instance's own
   * IPv6 on 8443. A relay inside a VM cannot reach its own node's public IPv4
   * (no hairpin NAT), but it can reach the instance's IPv6.
   */
  fallbacks?: Array<{ host: string; port: number }>
}

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
}>

export interface RelayOptions {
  /** Where `vm`'s attestation port is reachable on node `crn`. */
  resolveTarget: (crn: string, vm: string) => Promise<AttestationTarget>
  /** Bytes per direction before the connection is closed (default 4 MiB). */
  maxBytes?: number
  /** Seconds a connection may stay open (default 120). */
  maxSeconds?: number
  /** Open connections per client address (default 4). */
  maxPerClient?: number
  /** Open connections in total (default 256). */
  maxTotal?: number
  /** Allowed Origin headers; empty or absent allows any (it carries ciphertext only). */
  allowedOrigins?: string[]
  /**
   * Behind a reverse proxy on the same host (Caddy in the relay image), every
   * connection comes from loopback: count clients by the last X-Forwarded-For
   * entry instead, which the proxy appends. Only honoured for loopback peers.
   */
  trustProxy?: boolean
  /** Milliseconds to wait for a TCP connect before the next target (default 5000). */
  connectTimeoutMs?: number
  /** Tests only: allow loopback and private targets. */
  allowPrivateTargets?: boolean
  /** WebSocket path (default /attest). */
  path?: string
  log?: (message: string) => void
}

/** Global unicast IPv6 only (2000::/3), not the documentation range. */
export function isPublicIpv6(host: string): boolean {
  if (net.isIPv6(host) === false) return false
  const first = Number.parseInt(host.split(':')[0] || '0', 16)
  if ((first & 0xe000) !== 0x2000) return false
  return !/^2001:0?db8:/iu.test(host)
}

/** Public, routable IPv4 only: no loopback, private, link-local, CGNAT, multicast or reserved. */
export function isPublicIpv4(host: string): boolean {
  if (net.isIPv4(host) === false) return false
  const [a, b] = host.split('.').map(Number) as [number, number]
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 192 && b === 0) return false
  if (a === 198 && (b === 18 || b === 19)) return false
  return true
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** The address the per-client cap counts: the peer, or behind a local proxy the client it names. */
export function clientAddress(request: IncomingMessage, trustProxy = false): string {
  const peer = request.socket.remoteAddress ?? 'unknown'
  if (!trustProxy || !LOOPBACK.has(peer)) return peer
  const header = request.headers['x-forwarded-for']
  const forwarded = (Array.isArray(header) ? header.join(',') : header ?? '').split(',').map((entry) => entry.trim()).filter(Boolean)
  const last = forwarded.at(-1)
  return last && net.isIP(last) ? last : peer
}

/**
 * Where an instance's attestation port is mapped: the node's address from the
 * corechannel aggregate, then the instance's networking from that node's
 * executions list (v2, then v1).
 */
export async function resolveAttestationTarget(args: {
  crn: string
  vm: string
  fetch: FetchLike
  apiHost?: string
  timeoutMs?: number
}): Promise<AttestationTarget> {
  const timeout = () => AbortSignal.timeout(args.timeoutMs ?? 10_000)
  const aggregate = await args.fetch(
    `${args.apiHost ?? DEFAULT_ALEPH_API_HOST}/api/v0/aggregates/${CORECHANNEL_ADDRESS}.json?keys=corechannel`,
    { signal: timeout() },
  )
  if (!aggregate.ok) throw new Error(`corechannel aggregate answered ${aggregate.status}`)
  const nodes = ((await aggregate.json()) as {
    data?: { corechannel?: { resource_nodes?: Array<{ hash?: string; address?: string }> } }
  }).data?.corechannel?.resource_nodes ?? []
  const node = nodes.find((entry) => entry.hash === args.crn)
  const address = node?.address?.trim().replace(/\/+$/u, '')
  if (!address || !/^https:\/\//u.test(address)) throw new Error(`node ${args.crn} has no https address`)

  for (const path of ['/v2/about/executions/list', '/about/executions/list']) {
    const response = await args.fetch(`${address}${path}`, { signal: timeout() }).catch(() => null)
    if (!response?.ok) continue
    const executions = (await response.json()) as Record<string, {
      networking?: { host_ipv4?: string; ipv6_ip?: string; mapped_ports?: Record<string, { host?: number; tcp?: boolean }> }
    }>
    const networking = executions[args.vm]?.networking
    const host = networking?.host_ipv4
    const mapped = networking?.mapped_ports?.[ATTESTATION_PORT]
    const ipv6 = networking?.ipv6_ip?.trim()
    const fallbacks = ipv6 && isPublicIpv6(ipv6) ? [{ host: ipv6, port: Number(ATTESTATION_PORT) }] : []
    if (host && mapped?.host && mapped.tcp !== false) return { host, port: Number(mapped.host), fallbacks }
    throw new Error(`instance ${args.vm} has no mapped attestation port on node ${args.crn}`)
  }
  throw new Error(`node ${args.crn} did not list its executions`)
}

function reject(socket: import('node:stream').Duplex, status: number, reason: string) {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`)
  socket.destroy()
}

/** Attach the relay to an HTTP server's upgrade event. */
export function attachAttestRelay(server: Server, options: RelayOptions): { close(): void; open(): number } {
  const maxBytes = options.maxBytes ?? 4 * 1024 * 1024
  const maxSeconds = options.maxSeconds ?? 120
  const maxPerClient = options.maxPerClient ?? 4
  const maxTotal = options.maxTotal ?? 256
  const connectTimeoutMs = options.connectTimeoutMs ?? 5000
  const path = options.path ?? '/attest'
  const allowedOrigins = new Set(options.allowedOrigins?.filter(Boolean) ?? [])
  const log = options.log ?? (() => undefined)
  const perClient = new Map<string, number>()
  let total = 0
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 })

  server.on('upgrade', (request: IncomingMessage, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://relay.invalid')
    if (url.pathname !== path) return reject(socket, 404, 'Not Found')
    const crn = url.searchParams.get('crn') ?? ''
    const vm = url.searchParams.get('vm') ?? ''
    if (!HASH.test(crn) || !HASH.test(vm)) return reject(socket, 400, 'Bad Request')
    const origin = request.headers.origin ?? ''
    if (allowedOrigins.size > 0 && !allowedOrigins.has(origin)) return reject(socket, 403, 'Forbidden')
    const client = clientAddress(request, options.trustProxy)
    if (total >= maxTotal || (perClient.get(client) ?? 0) >= maxPerClient) {
      return reject(socket, 429, 'Too Many Requests')
    }

    // Count the connection from here on, so a slow resolve cannot be used to
    // exceed the caps.
    total += 1
    perClient.set(client, (perClient.get(client) ?? 0) + 1)
    let released = false
    const release = () => {
      if (released) return
      released = true
      total -= 1
      const left = (perClient.get(client) ?? 1) - 1
      if (left > 0) perClient.set(client, left)
      else perClient.delete(client)
    }

    options
      .resolveTarget(crn, vm)
      .then((target) => {
        const candidates = [{ host: target.host, port: target.port }, ...(target.fallbacks ?? [])].filter(
          (candidate) => options.allowPrivateTargets || isPublicIpv4(candidate.host) || isPublicIpv6(candidate.host),
        )
        if (candidates.length === 0 || candidates[0]!.host !== target.host) {
          throw new Error(`refusing non-public target ${target.host}`)
        }
        for (const candidate of candidates) {
          if (!Number.isInteger(candidate.port) || candidate.port < 1 || candidate.port > 65535) {
            throw new Error(`invalid target port ${candidate.port}`)
          }
        }
        wss.handleUpgrade(request, socket, head, (ws) => bridge(ws, candidates, crn, vm))
      })
      .catch((error: unknown) => {
        log(`[attest-relay] ${crn.slice(0, 12)}/${vm.slice(0, 12)}: ${error instanceof Error ? error.message : String(error)}`)
        release()
        reject(socket, 502, 'Bad Gateway')
      })

    const bridge = (ws: WebSocket, targets: Array<{ host: string; port: number }>, crnHash: string, vmHash: string) => {
      let up = 0
      let down = 0
      let tcp: net.Socket | null = null
      let connected = false
      let ended = false
      // What the browser sends before a connection is up (its ClientHello),
      // kept so a fallback target gets it too.
      const pending: Buffer[] = []
      const end = (why: string) => {
        if (ended) return
        ended = true
        clearTimeout(timer)
        tcp?.destroy()
        if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(1000, why.slice(0, 120))
        release()
      }
      const timer = setTimeout(() => end('time limit'), maxSeconds * 1000)
      const connect = (index: number) => {
        const target = targets[index]
        if (!target || ended) return end('guest connection failed')
        log(`[attest-relay] ${crnHash.slice(0, 12)}/${vmHash.slice(0, 12)} -> ${target.host}:${target.port}`)
        const socket = net.connect({ port: target.port, host: target.host })
        tcp = socket
        let abandoned = false
        const next = () => {
          if (abandoned || connected) return
          abandoned = true
          socket.destroy()
          connect(index + 1)
        }
        socket.setTimeout(connectTimeoutMs, next)
        socket.once('connect', () => {
          socket.setTimeout(0)
          connected = true
          for (const chunk of pending.splice(0)) socket.write(chunk)
        })
        socket.on('data', (chunk: Buffer) => {
          down += chunk.length
          if (down > maxBytes) return end('byte limit')
          ws.send(chunk, { binary: true })
        })
        socket.on('error', () => (connected && tcp === socket ? end('guest connection failed') : next()))
        socket.on('close', () => {
          if (connected && tcp === socket) end('guest closed')
        })
      }
      ws.on('message', (data: Buffer, isBinary: boolean) => {
        if (!isBinary) return end('binary frames only')
        up += data.length
        if (up > maxBytes) return end('byte limit')
        if (connected && tcp) tcp.write(data)
        else pending.push(data)
      })
      ws.on('close', () => end('client closed'))
      ws.on('error', () => end('client error'))
      connect(0)
    }
  })

  return {
    close: () => wss.close(),
    open: () => total,
  }
}
