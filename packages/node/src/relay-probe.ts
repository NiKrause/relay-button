import { networkInterfaces } from 'node:os'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'

import { noise } from '@chainsafe/libp2p-noise'
import { quic } from '@chainsafe/libp2p-quic'
import { yamux } from '@chainsafe/libp2p-yamux'
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { identify } from '@libp2p/identify'
import { peerIdFromString } from '@libp2p/peer-id'
import { ping } from '@libp2p/ping'
import { tcp } from '@libp2p/tcp'
import { webRTC, webRTCDirect } from '@libp2p/webrtc'
import { webSockets } from '@libp2p/websockets'
import { multiaddr, type Multiaddr } from '@multiformats/multiaddr'
import { createLibp2p } from 'libp2p'

import { integerEnv, jsonEnv } from './env.ts'

export interface RelayProbePolicy {
  requiredFamilies: Set<string>
  bestEffortFamilies: Set<string>
  proxyWssHostMatchers: string[]
  timeoutMs: number
  settleMs: number
  /**
   * Whether the probing host can reach IPv6 at all. When it cannot, IPv6
   * addresses are reported as not checked rather than as failures: a CI runner
   * without IPv6 says nothing about the relay.
   */
  ipv6Available: boolean
}

export interface RelayProbeResult {
  address: string
  protocols: string[]
  family: string
  required: boolean
  ok: boolean
  dialMs: number | null
  pingMs: number | null
  remoteAddrs: string[]
  error: string | null
  warning: string | null
  /** How the address was checked when that differs from dialing it as given. */
  note: string | null
}

function stringArrayEnv(name: string, fallback: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const value = jsonEnv<unknown>(name, fallback, env)
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${name} must be a JSON array of strings.`)
  }
  return value.map((entry) => entry.trim()).filter(Boolean)
}

export function relayProbePolicyFromEnv(env: NodeJS.ProcessEnv = process.env): RelayProbePolicy {
  return {
    requiredFamilies: new Set(stringArrayEnv('ALEPH_RELAY_PROBE_REQUIRED_FAMILIES_JSON', '["tcp","direct-wss","proxy-wss","webtransport"]', env)),
    bestEffortFamilies: new Set(stringArrayEnv('ALEPH_RELAY_PROBE_BEST_EFFORT_FAMILIES_JSON', '["webrtc-direct"]', env)),
    proxyWssHostMatchers: stringArrayEnv('ALEPH_RELAY_PROBE_PROXY_WSS_HOST_MATCHERS_JSON', '[".2n6.me/"]', env),
    timeoutMs: integerEnv('PROBE_TIMEOUT_MS', 20000, env),
    settleMs: integerEnv('PROBE_SETTLE_MS', 1500, env),
    ipv6Available: env.PROBE_IPV6 === 'true' ? true : env.PROBE_IPV6 === 'false' ? false : hostHasGlobalIpv6(),
  }
}

/**
 * True when some interface carries a global IPv6 address: not loopback, not
 * link-local (fe80::/10) and not unique-local (fc00::/7). Set PROBE_IPV6 to
 * override the detection.
 */
export function hostHasGlobalIpv6(interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): boolean {
  return Object.values(interfaces)
    .flat()
    .some(
      (entry) =>
        entry != null &&
        entry.family === 'IPv6' &&
        !entry.internal &&
        !/^fe[89ab]/i.test(entry.address) &&
        !/^f[cd]/i.test(entry.address)
    )
}

function isIpv6Address(protocols: string[]): boolean {
  return protocols.includes('ip6') || protocols.includes('dns6')
}

export function classifyRelayAddress(
  rawAddr: string,
  protocols: string[],
  policy: RelayProbePolicy
): { family: string; required: boolean } {
  if (protocols.includes('webrtc-direct')) {
    return {
      family: 'webrtc-direct',
      required: policy.requiredFamilies.has('webrtc-direct'),
    }
  }

  if (protocols.includes('webtransport')) {
    return {
      family: 'webtransport',
      required: policy.requiredFamilies.has('webtransport'),
    }
  }

  if (protocols.includes('ws') && policy.proxyWssHostMatchers.some((matcher) => rawAddr.includes(matcher))) {
    return {
      family: 'proxy-wss',
      required: policy.requiredFamilies.has('proxy-wss'),
    }
  }

  if (protocols.includes('ws')) {
    return {
      family: 'direct-wss',
      required: policy.requiredFamilies.has('direct-wss'),
    }
  }

  if (protocols.includes('tcp')) {
    return {
      family: 'tcp',
      required: policy.requiredFamilies.has('tcp'),
    }
  }

  return {
    family: 'other',
    required: policy.requiredFamilies.has('other'),
  }
}

/**
 * Protocol names of an address, in order. multiaddr 13 removed `protoNames()`;
 * this is what it returned.
 */
export function multiaddrProtocols(addr: Multiaddr): string[] {
  return addr.getComponents().map((component) => component.name)
}

/**
 * The peer an address dials, as multiaddr 12's removed `getPeerId()` resolved
 * it: the last `/p2p/` component, counting only those after the last
 * `/p2p-circuit`, so a relayed address yields its target rather than the
 * relay, and a relayed address without a target yields none. An unparseable
 * peer id yields none as well, as it did before.
 */
export function targetPeerId(addr: Multiaddr): ReturnType<typeof peerIdFromString> | null {
  let value: string | undefined
  for (const component of addr.getComponents()) {
    if (component.name === 'p2p') value = component.value
    if (component.name === 'p2p-circuit') value = undefined
  }
  if (value == null) return null
  try {
    return peerIdFromString(value)
  } catch {
    return null
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
  })

  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timeoutId != null) {
      clearTimeout(timeoutId)
    }
  }
}

async function createProbeNode() {
  return await createLibp2p({
    addresses: {
      listen: ['/ip4/0.0.0.0/tcp/0', '/ip4/0.0.0.0/udp/0/quic-v1', '/webrtc-direct'],
    },
    transports: [
      webSockets(),
      webRTC(),
      webRTCDirect(),
      circuitRelayTransport(),
      quic(),
      tcp(),
    ],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionGater: {
      denyDialMultiaddr: async () => false,
    },
    services: {
      identify: identify(),
      ping: ping(),
    },
  })
}

/**
 * The transport a connection runs over, reduced to what a probe family means.
 * Order matters: a websocket address also contains `tcp`, and a webtransport
 * address also contains `quic-v1`.
 */
export function transportOf(protocols: string[]): string {
  if (protocols.includes('p2p-circuit')) return 'circuit'
  if (protocols.includes('webrtc-direct')) return 'webrtc-direct'
  if (protocols.includes('webtransport')) return 'webtransport'
  if (protocols.includes('quic-v1') || protocols.includes('quic')) return 'quic'
  if (protocols.includes('ws') || protocols.includes('wss')) return 'ws'
  if (protocols.includes('tcp')) return 'tcp'
  return 'other'
}

/**
 * Node has no WebTransport transport, so a webtransport address cannot be
 * dialed from the probe as announced. uc-go-peer serves `quic-v1` and
 * `quic-v1/webtransport` from the same QUIC listener on the same UDP port, so
 * the probe dials that listener over libp2p QUIC instead. This proves the UDP
 * port is forwarded and the listener WebTransport runs on answers; it does
 * not exercise the HTTP/3 layer or check the certhash against the served
 * certificate. Returns null when there is no `quic-v1` to fall back to.
 */
export function quicSubstituteFor(addr: Multiaddr): Multiaddr | null {
  const components = addr.getComponents()
  if (!components.some((c) => c.name === 'webtransport') || !components.some((c) => c.name === 'quic-v1')) {
    return null
  }
  const kept = components.filter((c) => c.name !== 'webtransport' && c.name !== 'certhash')
  return multiaddr(kept.map((c) => (c.value == null ? `/${c.name}` : `/${c.name}/${c.value}`)).join(''))
}

const QUIC_SUBSTITUTE_NOTE =
  'webtransport checked over libp2p QUIC on the same UDP port: port forwarding and the QUIC listener are verified, ' +
  'the HTTP/3 layer and the certhash are not (Node has no WebTransport transport)'

type ProbeNode = Awaited<ReturnType<typeof createProbeNode>>

/**
 * Drop every connection to the peer. libp2p's dial() hands back an existing
 * connection to the same peer instead of opening one over the requested
 * transport, so without this each address after the first was judged on the
 * first one's connection (#187).
 */
async function closeConnectionsTo(node: ProbeNode, peerId: NonNullable<ReturnType<typeof targetPeerId>>): Promise<void> {
  try {
    await node.hangUp(peerId)
  } catch {
    // Nothing to close, or already closing: either way no connection is left to reuse.
  }
}

export async function probeRelayAddress(
  node: ProbeNode,
  rawAddr: string,
  policy: RelayProbePolicy
): Promise<RelayProbeResult> {
  const addr = multiaddr(rawAddr)
  const peerId = targetPeerId(addr)
  const protocols = multiaddrProtocols(addr)
  const classification = classifyRelayAddress(rawAddr, protocols, policy)

  const result: RelayProbeResult = {
    address: rawAddr,
    protocols,
    family: classification.family,
    required: classification.required,
    ok: false,
    dialMs: null,
    pingMs: null,
    remoteAddrs: [],
    error: null,
    warning: null,
    note: null,
  }

  if (isIpv6Address(protocols) && !policy.ipv6Available) {
    result.required = false
    result.note = 'not checked: the probing host has no global IPv6 address, so this says nothing about the relay'
    return result
  }

  try {
    if (peerId) await closeConnectionsTo(node, peerId)

    const substitute = transportOf(protocols) === 'webtransport' ? quicSubstituteFor(addr) : null
    const dialAddr = substitute ?? addr
    if (substitute) result.note = QUIC_SUBSTITUTE_NOTE

    const startedAt = Date.now()
    const connection = await withTimeout(node.dial(dialAddr), policy.timeoutMs, `dial ${dialAddr.toString()}`)
    result.dialMs = Date.now() - startedAt

    const requested = transportOf(multiaddrProtocols(dialAddr))
    const actual = transportOf(multiaddrProtocols(connection.remoteAddr))
    if (actual !== requested) {
      throw new Error(
        `dial returned a ${actual} connection (${connection.remoteAddr.toString()}) instead of ${requested}; ` +
          'the requested transport was not used'
      )
    }

    if (peerId) {
      await sleep(policy.settleMs)
      const connections = node.getConnections(peerId)
      result.remoteAddrs = connections.map((connection) => connection.remoteAddr.toString())

      try {
        const pingStartedAt = Date.now()
        await withTimeout(node.services.ping.ping(peerId), policy.timeoutMs, `ping ${rawAddr}`)
        result.pingMs = Date.now() - pingStartedAt
      } catch (error) {
        const message = `dial succeeded but ping failed: ${error instanceof Error ? error.message : String(error)}`
        if (policy.bestEffortFamilies.has(classification.family)) {
          result.warning = message
        } else {
          result.error = message
        }
      }
    }

    result.ok = true
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (policy.bestEffortFamilies.has(classification.family)) {
      result.warning = message
    } else {
      result.error = message
    }
    return result
  } finally {
    // Leave nothing behind for the next address to reuse.
    if (peerId) await closeConnectionsTo(node, peerId)
  }
}

export function summarizeRelayProbeResults(results: RelayProbeResult[]): { hasRequiredFailures: boolean } {
  return {
    hasRequiredFailures: results.some((result) => result.required && !result.ok),
  }
}

export async function probeRelayAddrs(
  addrs: string[],
  env: NodeJS.ProcessEnv = process.env
): Promise<RelayProbeResult[]> {
  const policy = relayProbePolicyFromEnv(env)
  const node = await createProbeNode()

  try {
    const results: RelayProbeResult[] = []
    for (const addr of addrs) {
      results.push(await probeRelayAddress(node, addr, policy))
    }
    return results
  } finally {
    await node.stop()
  }
}
