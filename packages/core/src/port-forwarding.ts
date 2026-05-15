import type {
  PortForwardAggregate,
  PortForwardAggregateEntry,
  PortForwardFlags,
  RootfsManifest,
  RootfsRequiredPortForward
} from '@shared-aleph/shared-types'

import { DEFAULT_ALEPH_API_HOST, type FetchLike } from './manifests.ts'

export const DEFAULT_INSTANCE_PORT_FORWARDS: RootfsRequiredPortForward[] = [
  { port: 22, tcp: true, udp: false, purpose: 'SSH' }
]

function normalizeRequestedPort(entry: RootfsRequiredPortForward): RootfsRequiredPortForward {
  return {
    port: entry.port,
    tcp: entry.tcp === true,
    udp: entry.udp === true,
    purpose: entry.purpose?.trim() || undefined
  }
}

function normalizePortFlags(value: unknown): PortForwardFlags | null {
  if (!value || typeof value !== 'object') return null

  const candidate = value as { tcp?: unknown; udp?: unknown }
  return {
    tcp: candidate.tcp === true,
    udp: candidate.udp === true
  }
}

export function normalizeExistingPortForwardEntry(
  entry: PortForwardAggregateEntry | null | undefined
): Record<string, PortForwardFlags> {
  if (!entry?.ports || typeof entry.ports !== 'object') return {}

  return Object.fromEntries(
    Object.entries(entry.ports)
      .map(([port, flags]) => [port, normalizePortFlags(flags)] as const)
      .filter((item): item is [string, PortForwardFlags] => item[1] != null)
  )
}

export function requestedPortFlags(
  portForwards: ReadonlyArray<RootfsRequiredPortForward>
): Record<string, PortForwardFlags> {
  return Object.fromEntries(
    portForwards.map((entry) => [
      String(entry.port),
      {
        tcp: entry.tcp === true,
        udp: entry.udp === true
      }
    ])
  )
}

export function mergePortFlagMaps(
  existing: Record<string, PortForwardFlags>,
  requested: Record<string, PortForwardFlags>
): Record<string, PortForwardFlags> {
  const merged = new Map<string, PortForwardFlags>()

  for (const [port, flags] of Object.entries(existing)) {
    merged.set(port, {
      tcp: flags.tcp === true,
      udp: flags.udp === true
    })
  }

  for (const [port, flags] of Object.entries(requested)) {
    const current = merged.get(port)
    merged.set(port, {
      tcp: current?.tcp === true || flags.tcp === true,
      udp: current?.udp === true || flags.udp === true
    })
  }

  return Object.fromEntries([...merged.entries()].sort((left, right) => Number(left[0]) - Number(right[0])))
}

export function mergeRequiredPortForwards(
  ...groups: Array<ReadonlyArray<RootfsRequiredPortForward> | undefined>
): RootfsRequiredPortForward[] {
  const merged = new Map<number, RootfsRequiredPortForward>()

  for (const group of groups) {
    for (const entry of group ?? []) {
      const normalized = normalizeRequestedPort(entry)
      const current = merged.get(normalized.port)
      merged.set(normalized.port, {
        port: normalized.port,
        tcp: current?.tcp === true || normalized.tcp === true,
        udp: current?.udp === true || normalized.udp === true,
        purpose: current?.purpose ?? normalized.purpose
      })
    }
  }

  return [...merged.values()].sort((left, right) => left.port - right.port)
}

export function requiredInstancePortForwards(manifest: RootfsManifest | null): RootfsRequiredPortForward[] {
  return mergeRequiredPortForwards(DEFAULT_INSTANCE_PORT_FORWARDS, manifest?.requiredPortForwards)
}

export function portForwardLabel(entry: RootfsRequiredPortForward): string {
  const protocols = [entry.tcp === true ? 'TCP' : null, entry.udp === true ? 'UDP' : null]
    .filter((value): value is string => Boolean(value))
    .join('/')

  return `${entry.port}/${protocols}`
}

export async function fetchPortForwardAggregate(
  address: string,
  options: {
    apiHost?: string
    fetch: FetchLike
  }
): Promise<PortForwardAggregate> {
  const requestUrl = new URL(`/api/v0/aggregates/${address}.json`, options.apiHost ?? DEFAULT_ALEPH_API_HOST)
  requestUrl.searchParams.set('keys', 'port-forwarding')

  const response = await options.fetch(requestUrl.toString(), { cache: 'no-cache' })
  if (response.status === 404) return {}
  if (!response.ok) {
    throw new Error(`Port-forward aggregate request failed: ${response.status}`)
  }

  const payload = (await response.json()) as { data?: Record<string, unknown> }
  const aggregate = payload.data?.['port-forwarding']
  if (!aggregate || typeof aggregate !== 'object' || Array.isArray(aggregate)) return {}

  return aggregate as PortForwardAggregate
}
