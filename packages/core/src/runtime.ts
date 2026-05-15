import type {
  CrnRecord,
  InstanceAllocation,
  InstanceRuntimeDetails,
  InstanceWebAccess,
  RuntimeDiagnostics
} from '@shared-aleph/shared-types'

import { normalizeExecution, normalizeProxyUrl } from './aleph-normalizers.ts'
import { fetchCrns, DEFAULT_CRN_LIST_URL } from './crns.ts'
import { type FetchLike } from './manifests.ts'

export const DEFAULT_SCHEDULER_ALLOCATION_URL = 'https://scheduler.api.aleph.cloud/api/v0/allocation'
export const DEFAULT_TWO_N_SIX_HASH_URL = 'https://api.2n6.me/api/hash'

type SchedulerAllocationPayload = {
  node?: {
    node_id?: unknown
    url?: unknown
    ipv6?: unknown
    supports_ipv6?: unknown
  } | null
  vm_ipv6?: unknown
  period?: {
    start_timestamp?: unknown
    duration_seconds?: unknown
  } | null
}

type TwoN6Payload = {
  url?: unknown
  subdomain?: unknown
  active?: unknown
}

type CrnExecutionLookup = {
  version: 'v1' | 'v2'
  payload: Record<string, unknown> | null
  requestUrl: string
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function findCrnByHash(crns: ReadonlyArray<CrnRecord>, crnHash: string): CrnRecord | null {
  return crns.find((crn) => crn.hash === crnHash) ?? null
}

export async function fetchSchedulerAllocation(
  itemHash: string,
  options: {
    fetch: FetchLike
    schedulerAllocationUrl?: string
  }
): Promise<InstanceAllocation | null> {
  const response = await options.fetch(
    `${options.schedulerAllocationUrl ?? DEFAULT_SCHEDULER_ALLOCATION_URL}/${itemHash}`,
    { cache: 'no-cache' }
  )

  if (response.status === 404) return null
  if (!response.ok) {
    throw new Error(`Scheduler allocation request failed: ${response.status}`)
  }

  const payload = (await response.json()) as SchedulerAllocationPayload
  const node = payload?.node
  return {
    source: 'scheduler',
    crnHash: asString(node?.node_id),
    crnUrl: asString(node?.url),
    node: node
      ? {
          node_id: asString(node.node_id) ?? undefined,
          url: asString(node.url) ?? undefined,
          ipv6: asString(node.ipv6),
          supports_ipv6: typeof node.supports_ipv6 === 'boolean' ? node.supports_ipv6 : undefined
        }
      : null,
    vmIpv6: asString(payload?.vm_ipv6),
    period: payload?.period
      ? {
          start_timestamp: asString(payload.period.start_timestamp) ?? undefined,
          duration_seconds: asNumber(payload.period.duration_seconds) ?? undefined
        }
      : null
  }
}

export async function fetch2n6WebAccessUrl(
  itemHash: string,
  options: {
    fetch: FetchLike
    twoN6HashUrl?: string
  }
): Promise<InstanceWebAccess | null> {
  const response = await options.fetch(
    `${options.twoN6HashUrl ?? DEFAULT_TWO_N_SIX_HASH_URL}/${itemHash}`,
    { cache: 'no-cache' }
  )

  if (!response.ok) return null
  const payload = (await response.json()) as TwoN6Payload
  return {
    url: normalizeProxyUrl(payload?.url ?? payload?.subdomain),
    active: typeof payload?.active === 'boolean' ? payload.active : null,
    subdomain: asString(payload?.subdomain)
  }
}

export async function fetchCrnExecutionMap(
  crnUrl: string,
  options: {
    fetch: FetchLike
  }
): Promise<CrnExecutionLookup> {
  const normalizedCrnUrl = String(crnUrl).replace(/\/+$/, '')
  for (const [version, suffix] of [
    ['v2', '/v2/about/executions/list'],
    ['v1', '/about/executions/list']
  ] as const) {
    const requestUrl = `${normalizedCrnUrl}${suffix}`
    const response = await options.fetch(requestUrl, {
      cache: 'no-cache'
    })

    if (response.ok) {
      const payload = await response.json()
      return {
        version,
        payload: payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null,
        requestUrl
      }
    }

    if (response.status !== 404) {
      return {
        version,
        payload: null,
        requestUrl
      }
    }
  }

  return {
    version: 'v2',
    payload: null,
    requestUrl: `${normalizedCrnUrl}/v2/about/executions/list`
  }
}

export function describeRuntimeAvailability(runtime: {
  allocation?: InstanceAllocation | null
  execution?: InstanceRuntimeDetails['execution']
  webAccess?: InstanceWebAccess | null
  hostIpv4?: string | null
  ipv6?: string | null
  proxyUrl?: string | null
  mappedPorts?: Record<string, unknown>
}): RuntimeDiagnostics {
  const execution = runtime.execution ?? null
  const mappedPorts = runtime.mappedPorts ?? {}
  const hostIpv4 = runtime.hostIpv4 ?? null
  const proxyUrl = runtime.proxyUrl ?? null
  const schedulerSource = runtime.allocation?.source ?? null
  const webAccessActive = runtime.webAccess?.active ?? null
  const mappedPortCount = Object.keys(mappedPorts).length

  if (hostIpv4 && mappedPortCount > 0) {
    return {
      state: 'ready',
      reason: null,
      schedulerSource,
      executionSeen: Boolean(execution),
      webAccessActive,
      mappedPortCount,
      proxyUrl
    }
  }

  if (!execution && proxyUrl && webAccessActive === false) {
    return {
      state: 'proxy-reserved-inactive',
      reason:
        'Aleph reserved a proxy URL for the VM, but it is still inactive and the selected CRN has not exposed execution networking yet.',
      schedulerSource,
      executionSeen: false,
      webAccessActive,
      mappedPortCount,
      proxyUrl
    }
  }

  if (!execution && schedulerSource === 'manual') {
    return {
      state: 'crn-execution-missing',
      reason:
        'The deployment is pinned to a specific CRN, but that CRN is not exposing this VM in its execution list yet.',
      schedulerSource,
      executionSeen: false,
      webAccessActive,
      mappedPortCount,
      proxyUrl
    }
  }

  if (execution && !hostIpv4) {
    return {
      state: 'execution-missing-host-ipv4',
      reason: 'The CRN exposed an execution record, but it does not include a public host IPv4 yet.',
      schedulerSource,
      executionSeen: true,
      webAccessActive,
      mappedPortCount,
      proxyUrl
    }
  }

  if (execution && mappedPortCount === 0) {
    return {
      state: 'execution-missing-port-mappings',
      reason: 'The CRN exposed an execution record, but mapped ports are still empty.',
      schedulerSource,
      executionSeen: true,
      webAccessActive,
      mappedPortCount,
      proxyUrl
    }
  }

  return {
    state: 'runtime-pending',
    reason: 'Aleph has not exposed enough runtime networking details yet.',
    schedulerSource,
    executionSeen: Boolean(execution),
    webAccessActive,
    mappedPortCount,
    proxyUrl
  }
}

export async function fetchVmRuntime(args: {
  itemHash: string
  fetch: FetchLike
  crns?: CrnRecord[]
  crnHash?: string
  crnListUrl?: string
  schedulerAllocationUrl?: string
  twoN6HashUrl?: string
}): Promise<Omit<InstanceRuntimeDetails, 'messageStatus'>> {
  const crns = args.crns ?? (await fetchCrns({
    url: args.crnListUrl ?? DEFAULT_CRN_LIST_URL,
    fetch: args.fetch
  }))
  const schedulerAllocation = await fetchSchedulerAllocation(args.itemHash, {
    fetch: args.fetch,
    schedulerAllocationUrl: args.schedulerAllocationUrl
  }).catch(() => null)

  const selectedCrn = args.crnHash ? findCrnByHash(crns, args.crnHash) : null
  const allocation =
    schedulerAllocation ??
    (selectedCrn
      ? {
          source: 'manual' as const,
          crnHash: selectedCrn.hash,
          crnUrl: selectedCrn.address,
          node: { url: selectedCrn.address },
          vmIpv6: null,
          period: null
        }
      : null)

  const webAccess = await fetch2n6WebAccessUrl(args.itemHash, {
    fetch: args.fetch,
    twoN6HashUrl: args.twoN6HashUrl
  }).catch(() => null)

  const webAccessUrl = webAccess?.url ?? null
  let execution = null
  let executionLookupBlocked = false

  if (allocation?.crnUrl) {
    const executionLookup = await fetchCrnExecutionMap(allocation.crnUrl, {
      fetch: args.fetch
    })
    const executionPayload = executionLookup.payload?.[args.itemHash]
    if (executionPayload && typeof executionPayload === 'object') {
      execution = normalizeExecution(executionPayload, allocation.crnUrl)
      if (!execution.networking.proxy_url && webAccessUrl) {
        execution.networking.proxy_url = webAccessUrl
      }
    } else if (executionLookup.payload == null) {
      executionLookupBlocked = true
    }
  }

  const hostIpv4 = execution?.networking?.host_ipv4 ?? execution?.networking?.ipv4 ?? null
  const ipv6 = execution?.networking?.ipv6_ip ?? execution?.networking?.ipv6 ?? allocation?.vmIpv6 ?? null
  const mappedPorts = execution?.networking?.mapped_ports ?? {}
  const sshPort = mappedPorts?.['22']?.host ?? null
  const proxyUrl = execution?.networking?.proxy_url ?? webAccessUrl ?? null
  const diagnostics = describeRuntimeAvailability({
    allocation,
    execution,
    webAccess,
    hostIpv4,
    ipv6,
    proxyUrl,
    mappedPorts
  })

  return {
    allocation,
    execution,
    webAccess,
    webAccessUrl,
    hostIpv4,
    ipv6,
    proxyUrl,
    mappedPorts,
    diagnostics,
    sshCommand: hostIpv4 && sshPort ? `ssh root@${hostIpv4} -p ${sshPort}` : ipv6 ? `ssh root@${ipv6}` : null,
    selectedCrn,
    executionLookupBlocked
  }
}

export async function waitForVmRuntime(args: {
  itemHash: string
  fetch: FetchLike
  crns?: CrnRecord[]
  crnHash?: string
  crnListUrl?: string
  schedulerAllocationUrl?: string
  twoN6HashUrl?: string
  attempts?: number
  delayMs?: number
  sleep?: (ms: number) => Promise<void>
  onAttempt?: (runtime: Omit<InstanceRuntimeDetails, 'messageStatus'>, attempt: number, attempts: number) => void
}): Promise<Omit<InstanceRuntimeDetails, 'messageStatus'>> {
  const attempts = Math.max(1, Number(args.attempts ?? 20))
  const delayMs = Math.max(0, Number(args.delayMs ?? 4000))
  const sleep = args.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))

  let lastRuntime = await fetchVmRuntime(args)
  args.onAttempt?.(lastRuntime, 1, attempts)
  for (let attempt = 0; attempt < attempts - 1; attempt += 1) {
    if (lastRuntime.hostIpv4 && Object.keys(lastRuntime.mappedPorts ?? {}).length > 0) {
      return lastRuntime
    }
    await sleep(delayMs)
    lastRuntime = await fetchVmRuntime(args)
    args.onAttempt?.(lastRuntime, attempt + 2, attempts)
  }

  if (lastRuntime.diagnostics) {
    lastRuntime.diagnostics.timedOut = true
  }

  return lastRuntime
}
