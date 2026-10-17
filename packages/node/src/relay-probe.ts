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
  }
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

export async function probeRelayAddress(
  node: Awaited<ReturnType<typeof createProbeNode>>,
  rawAddr: string,
  policy: RelayProbePolicy
): Promise<RelayProbeResult> {
  const addr = multiaddr(rawAddr)
  const peerId = targetPeerId(addr)
  const protocols = multiaddrProtocols(addr)
  const classification = classifyRelayAddress(rawAddr, protocols, policy)
  const startedAt = Date.now()

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
  }

  try {
    await withTimeout(node.dial(addr), policy.timeoutMs, `dial ${rawAddr}`)
    result.dialMs = Date.now() - startedAt

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
