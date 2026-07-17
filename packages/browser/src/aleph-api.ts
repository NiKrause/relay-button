import { fetchWithTimeout } from './http'
import type {
  AllocationNotifyResult,
  AlephMessageEnvelope,
  AlephBroadcastMessage,
  AlephBroadcastResponse,
  BalanceResponse,
  BroadcastResult,
  Crn,
  CrnExecutionLookupResult,
  CrnListResponse,
  DeploymentInspectionResult,
  InstanceAllocation,
  InstanceExecution,
  InstanceMessage,
  MessageReference,
  MessageStatus,
  RelaySetupRequest,
  RelaySetupResult
} from './types'

export const DEFAULT_ALEPH_API_HOSTS: readonly string[] = [
  'https://api2.aleph.im',
  'https://api.aleph.im'
]
export const DEFAULT_ALEPH_API_HOST: string = DEFAULT_ALEPH_API_HOSTS[0] ?? 'https://api2.aleph.im'
export const DEFAULT_CRN_LIST_URL = 'https://crns-list.aleph.sh/crns.json'
export const DEFAULT_ALEPH_SCHEDULER_API_HOST = 'https://scheduler.api.aleph.cloud'
export const DEFAULT_2N6_API_HOST = 'https://api.2n6.me'

type SchedulerAllocationPayload = {
  vm_hash?: unknown
  vm_ipv6?: unknown
  period?: {
    start_timestamp?: unknown
    duration_seconds?: unknown
  } | null
  node?: {
    node_id?: unknown
    url?: unknown
    ipv6?: unknown
    supports_ipv6?: unknown
  } | null
}

type CrnExecutionV1Payload = {
  networking?: {
    ipv4?: unknown
    ipv6?: unknown
  } | null
}

type CrnExecutionV2Payload = {
  networking?: {
    ipv4_network?: unknown
    host_ipv4?: unknown
    ipv6_network?: unknown
    ipv6_ip?: unknown
    ipv4_ip?: unknown
    proxy_url?: unknown
    proxyUrl?: unknown
    web_access_url?: unknown
    webAccessUrl?: unknown
    proxy_hostname?: unknown
    proxyHostname?: unknown
    domain?: unknown
    hostname?: unknown
    mapped_ports?: Record<string, { host?: unknown; tcp?: unknown; udp?: unknown }> | null
  } | null
  web_access?: {
    url?: unknown
    proxy_url?: unknown
    hostname?: unknown
    domain?: unknown
  } | null
  webAccess?: {
    url?: unknown
    proxy_url?: unknown
    hostname?: unknown
    domain?: unknown
  } | null
  status?: {
    defined_at?: unknown
    preparing_at?: unknown
    prepared_at?: unknown
    starting_at?: unknown
    started_at?: unknown
    stopping_at?: unknown
    stopped_at?: unknown
  } | null
  running?: unknown
}

type CrnExecutionMapPayload = Record<string, CrnExecutionV1Payload | CrnExecutionV2Payload>

type TwoN6HashLookupPayload = {
  instance_hash?: unknown
  subdomain?: unknown
  url?: unknown
  ipv6?: unknown
  active?: unknown
}

export function normalizeMessageStatus(status: unknown): MessageStatus {
  if (typeof status !== 'string') return 'unknown'

  const normalized = status.toLowerCase()
  if (normalized === 'processed' || normalized === 'pending' || normalized === 'rejected') {
    return normalized
  }

  return 'unknown'
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function isUnconfirmedNetworkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return error instanceof TypeError || message.includes('Failed to fetch') || message.includes('Request timed out')
}

function normalizeProxyUrl(value: unknown): string | null {
  const stringValue = asString(value)
  if (!stringValue) return null
  if (/^https?:\/\//i.test(stringValue)) return stringValue
  return `https://${stringValue}`
}

function extractProxyUrl(value: CrnExecutionV2Payload, networking: CrnExecutionV2Payload['networking']): string | null {
  const networkingCandidates = [
    networking?.proxy_url,
    networking?.proxyUrl,
    networking?.web_access_url,
    networking?.webAccessUrl,
    networking?.proxy_hostname,
    networking?.proxyHostname,
    networking?.domain,
    networking?.hostname
  ]

  for (const candidate of networkingCandidates) {
    const normalized = normalizeProxyUrl(candidate)
    if (normalized) return normalized
  }

  for (const entry of [value.web_access, value.webAccess]) {
    const normalized =
      normalizeProxyUrl(entry?.url) ??
      normalizeProxyUrl(entry?.proxy_url) ??
      normalizeProxyUrl(entry?.hostname) ??
      normalizeProxyUrl(entry?.domain)

    if (normalized) return normalized
  }

  return null
}

export async function fetchBalance(address: string, apiHost = DEFAULT_ALEPH_API_HOST): Promise<BalanceResponse> {
  const response = await fetchWithTimeout(`${apiHost}/api/v0/addresses/${address}/balance`, {
    cache: 'no-cache'
  })

  if (!response.ok) throw new Error(`Balance request failed: ${response.status}`)
  return (await response.json()) as BalanceResponse
}

export async function fetchCrns(url = DEFAULT_CRN_LIST_URL): Promise<Crn[]> {
  const requestUrl = new URL(url)
  requestUrl.searchParams.set('filter_inactive', 'true')

  const response = await fetchWithTimeout(requestUrl, { cache: 'no-cache' })
  if (!response.ok) throw new Error(`CRN list request failed: ${response.status}`)

  const payload = (await response.json()) as CrnListResponse
  return payload.crns ?? []
}

export async function fetchInstances(address: string, apiHost = DEFAULT_ALEPH_API_HOST): Promise<InstanceMessage[]> {
  const url = new URL('/api/v0/messages.json', apiHost)
  url.searchParams.set('msgTypes', 'INSTANCE')
  url.searchParams.set('addresses', address)
  url.searchParams.set('message_statuses', 'processed,pending,rejected')
  url.searchParams.set('pagination', '100')
  url.searchParams.set('page', '1')
  url.searchParams.set('sortOrder', '-1')

  const response = await fetchWithTimeout(url, { cache: 'no-cache' })
  if (!response.ok) throw new Error(`Instance list request failed: ${response.status}`)

  const payload = (await response.json()) as { messages?: InstanceMessage[] }
  return (payload.messages ?? []).map((message) => ({
    ...message,
    status:
      typeof message.status === 'string' && message.status.trim()
        ? message.status
        : message.confirmed
          ? 'processed'
          : 'pending'
  }))
}

export async function fetch2n6WebAccessUrl(
  itemHash: string,
  twoN6ApiHost = DEFAULT_2N6_API_HOST
): Promise<string | null> {
  const requestUrl = new URL(`/api/hash/${itemHash}`, twoN6ApiHost).toString()

  try {
    const response = await fetchWithTimeout(requestUrl, { cache: 'no-cache' })
    if (response.status === 404 || !response.ok) {
      return null
    }

    const payload = (await response.json()) as TwoN6HashLookupPayload
    return normalizeProxyUrl(payload.url ?? payload.subdomain)
  } catch {
    return null
  }
}

export async function fetchSchedulerAllocation(
  itemHash: string,
  schedulerApiHost = DEFAULT_ALEPH_SCHEDULER_API_HOST
): Promise<InstanceAllocation | null> {
  const response = await fetchWithTimeout(`${schedulerApiHost}/api/v0/allocation/${itemHash}`, {
    cache: 'no-cache'
  })

  if (response.status === 404) return null
  if (!response.ok) throw new Error(`Scheduler allocation request failed: ${response.status}`)

  const payload = (await response.json()) as SchedulerAllocationPayload
  const node = payload.node

  return {
    source: 'scheduler',
    crnUrl: asString(node?.url),
    node: node
      ? {
          node_id: asString(node.node_id) ?? undefined,
          url: asString(node.url) ?? undefined,
          ipv6: asString(node.ipv6),
          supports_ipv6: typeof node.supports_ipv6 === 'boolean' ? node.supports_ipv6 : undefined
        }
      : null,
    vmIpv6: asString(payload.vm_ipv6),
    period: payload.period
      ? {
          start_timestamp: asString(payload.period.start_timestamp) ?? undefined,
          duration_seconds: asNumber(payload.period.duration_seconds) ?? undefined
        }
      : null
  }
}

export async function fetchCrnExecutionMap(crnUrl: string): Promise<CrnExecutionLookupResult> {
  const normalizedCrnUrl = crnUrl.replace(/\/+$/, '')
  const v2Url = `${normalizedCrnUrl}/v2/about/executions/list`
  const v1Url = `${normalizedCrnUrl}/about/executions/list`

  try {
    const v2Response = await fetchWithTimeout(v2Url, { cache: 'no-cache' })
    if (v2Response.ok) {
      const payload = (await v2Response.json()) as CrnExecutionMapPayload
      return {
        payload,
        blocked: false,
        requestUrl: v2Url,
        version: 'v2'
      }
    }

    if (v2Response.status !== 404) {
      return { payload: null, blocked: false, requestUrl: v2Url, version: 'v2' }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof TypeError || message.includes('Failed to fetch')) {
      return { payload: null, blocked: true, requestUrl: v2Url, version: 'v2' }
    }

    return { payload: null, blocked: false, requestUrl: v2Url, version: 'v2' }
  }

  try {
    const v1Response = await fetchWithTimeout(v1Url, { cache: 'no-cache' })
    if (!v1Response.ok) {
      return { payload: null, blocked: false, requestUrl: v1Url, version: 'v1' }
    }

    const payload = (await v1Response.json()) as CrnExecutionMapPayload
    return {
      payload,
      blocked: false,
      requestUrl: v1Url,
      version: 'v1'
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof TypeError || message.includes('Failed to fetch')) {
      return { payload: null, blocked: true, requestUrl: v1Url, version: 'v1' }
    }

    return { payload: null, blocked: false, requestUrl: v1Url, version: 'v1' }
  }
}

export function normalizeExecution(
  item: CrnExecutionV1Payload | CrnExecutionV2Payload,
  crnUrl: string
): InstanceExecution {
  const networking = item.networking ?? null
  const mappedPorts =
    networking && 'mapped_ports' in networking && networking.mapped_ports && typeof networking.mapped_ports === 'object'
      ? Object.fromEntries(
          Object.entries(networking.mapped_ports).map(([port, mapping]) => [
            port,
            {
              host: asNumber(mapping?.host) ?? undefined,
              tcp: typeof mapping?.tcp === 'boolean' ? mapping.tcp : undefined,
              udp: typeof mapping?.udp === 'boolean' ? mapping.udp : undefined
            }
          ])
        )
      : undefined

  if (networking && ('host_ipv4' in networking || 'ipv6_ip' in networking || 'ipv4_network' in networking)) {
    const v2Item = item as CrnExecutionV2Payload
    return {
      crnUrl,
      version: 'v2',
      running: typeof v2Item.running === 'boolean' ? v2Item.running : undefined,
      networking: {
        ipv4_network: asString(networking.ipv4_network),
        host_ipv4: asString(networking.host_ipv4),
        ipv6_network: asString(networking.ipv6_network),
        ipv6_ip: asString(networking.ipv6_ip),
        ipv4_ip: asString(networking.ipv4_ip),
        proxy_url: extractProxyUrl(v2Item, networking),
        mapped_ports: mappedPorts
      },
      status: v2Item.status
        ? {
            defined_at: asString(v2Item.status.defined_at),
            preparing_at: asString(v2Item.status.preparing_at),
            prepared_at: asString(v2Item.status.prepared_at),
            starting_at: asString(v2Item.status.starting_at),
            started_at: asString(v2Item.status.started_at),
            stopping_at: asString(v2Item.status.stopping_at),
            stopped_at: asString(v2Item.status.stopped_at)
          }
        : null
    }
  }

  return {
    crnUrl,
    version: 'v1',
    networking: {
      ipv4: networking && 'ipv4' in networking ? asString(networking.ipv4) : null,
      ipv6: networking && 'ipv6' in networking ? asString(networking.ipv6) : null
    },
    status: null
  }
}

export async function notifyCrnAllocation(crnUrl: string, itemHash: string): Promise<AllocationNotifyResult> {
  const normalizedCrnUrl = crnUrl.replace(/\/+$/, '')

  try {
    const response = await fetchWithTimeout(`${normalizedCrnUrl}/control/allocation/notify`, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain;charset=UTF-8'
      },
      body: JSON.stringify({ instance: itemHash }),
      mode: 'cors'
    })

    if (!response.ok) {
      const responseText = await response.text().catch(() => '')
      throw new Error(`CRN allocation notify failed: ${response.status}${responseText ? ` ${responseText}` : ''}`)
    }

    return { status: 'confirmed' }
  } catch (error) {
    if (isUnconfirmedNetworkError(error)) {
      return { status: 'unconfirmed' }
    }

    throw error
  }
}

export async function configureOrbitdbRelaySetup(args: RelaySetupRequest): Promise<RelaySetupResult> {
  const targetUrl = `http://${args.hostIpv4}:${args.setupPort}/configure`

  try {
    const response = await fetchWithTimeout(
      targetUrl,
      {
        method: 'POST',
        headers: {
          'content-type': 'text/plain;charset=UTF-8'
        },
        body: JSON.stringify({
          public_ipv4: args.hostIpv4,
          public_ipv6: args.publicIpv6 ?? undefined,
          tcp_port: args.tcpPort,
          ws_port: args.wsPort,
          proxy_url: args.proxyUrl ?? undefined,
          metrics_port: args.metricsPort ?? undefined,
          metrics_https_port: args.metricsHttpsPort ?? undefined,
          webrtc_port: args.webrtcPort ?? undefined,
          quic_port: args.quicPort ?? undefined
        }),
        mode: 'cors'
      },
      30000
    )

    if (!response.ok) {
      const responseText = await response.text().catch(() => '')
      throw new Error(`Relay setup request failed: ${response.status}${responseText ? ` ${responseText}` : ''}`)
    }

    return { status: 'configured' }
  } catch (error) {
    if (isUnconfirmedNetworkError(error)) {
      return { status: 'unconfirmed' }
    }

    throw error
  }
}

function messageTypeFromEnvelope(payload: AlephMessageEnvelope | null): string | null {
  if (!payload) return null

  const type =
    payload.type ??
    payload.message?.type ??
    (Array.isArray(payload.messages) ? payload.messages[0]?.type : undefined)

  return typeof type === 'string' ? type.toUpperCase() : null
}

function extractReferenceHashes(details: unknown): string[] {
  if (!details || typeof details !== 'object' || !('errors' in details)) return []

  const errors = (details as { errors?: unknown }).errors
  if (!Array.isArray(errors)) return []

  return errors.filter((value): value is string => typeof value === 'string')
}

function extractInsufficientBalanceMessage(details: unknown): string | null {
  if (!details || typeof details !== 'object' || !('errors' in details)) return null

  const errors = (details as { errors?: unknown }).errors
  const firstError =
    Array.isArray(errors) && errors[0] && typeof errors[0] === 'object'
      ? (errors[0] as Record<string, unknown>)
      : null

  const accountBalance =
    typeof firstError?.account_balance === 'number' || typeof firstError?.account_balance === 'string'
      ? Number(firstError.account_balance)
      : Number.NaN
  const requiredBalance =
    typeof firstError?.required_balance === 'number' || typeof firstError?.required_balance === 'string'
      ? Number(firstError.required_balance)
      : Number.NaN

  if (!Number.isFinite(accountBalance) || !Number.isFinite(requiredBalance)) {
    return null
  }

  const shortfall = requiredBalance - accountBalance
  return shortfall > 0
    ? `insufficient Aleph balance: ${accountBalance.toFixed(3)} available, ${requiredBalance.toFixed(3)} required, ${shortfall.toFixed(3)} short`
    : `insufficient Aleph balance: ${accountBalance.toFixed(3)} available, ${requiredBalance.toFixed(3)} required`
}

function describeRejectedDeployment(
  payload: AlephMessageEnvelope,
  references: MessageReference[],
  rootfsRef?: string
): string {
  const errorCode = typeof payload.error_code === 'number' ? payload.error_code : null
  const pendingReferences = references.filter((reference) => reference.status === 'pending')
  const missingReferences = references.filter((reference) => reference.status === 'missing')
  const rootfsReference = references.find((reference) => reference.itemHash === rootfsRef)

  if (rootfsReference?.status === 'pending') {
    return `Aleph rejected this deployment because the referenced rootfs STORE message ${rootfsReference.itemHash} is still pending and cannot yet be used by an instance. Wait for that STORE message to process, then deploy again.`
  }

  if (pendingReferences.length > 0) {
    return `Aleph rejected this deployment because referenced message(s) are still pending: ${pendingReferences.map((reference) => reference.itemHash).join(', ')}.`
  }

  if (missingReferences.length > 0) {
    return `Aleph rejected this deployment because referenced message(s) were not found on Aleph: ${missingReferences.map((reference) => reference.itemHash).join(', ')}.`
  }

  const insufficientBalanceMessage = extractInsufficientBalanceMessage(payload.details)
  if (insufficientBalanceMessage) {
    return `Aleph rejected this deployment due to ${insufficientBalanceMessage}.`
  }

  const referencedHashes = extractReferenceHashes(payload.details)
  if (referencedHashes.length > 0) {
    return `Aleph rejected this deployment${errorCode ? ` (error ${errorCode})` : ''}. Referenced message(s): ${referencedHashes.join(', ')}.`
  }

  return `Aleph rejected this deployment${errorCode ? ` (error ${errorCode})` : ''}.`
}

export async function fetchMessageEnvelope(
  itemHash: string,
  apiHost = DEFAULT_ALEPH_API_HOST
): Promise<AlephMessageEnvelope | null> {
  const response = await fetchWithTimeout(`${apiHost}/api/v0/messages/${itemHash}`, {
    cache: 'no-cache'
  })

  if (response.status === 404) return null
  if (!response.ok) throw new Error(`Message lookup failed: ${response.status}`)

  return (await response.json()) as AlephMessageEnvelope
}

async function fetchReference(itemHash: string, apiHost: string): Promise<MessageReference> {
  const payload = await fetchMessageEnvelope(itemHash, apiHost)
  if (!payload) {
    return {
      itemHash,
      status: 'missing',
      type: null
    }
  }

  return {
    itemHash,
    status: normalizeMessageStatus(payload.status),
    type: messageTypeFromEnvelope(payload)
  }
}

export async function inspectDeploymentResult(
  itemHash: string,
  rootfsRef?: string,
  apiHost = DEFAULT_ALEPH_API_HOST
): Promise<DeploymentInspectionResult> {
  const payload = await fetchMessageEnvelope(itemHash, apiHost)
  if (!payload) {
    return {
      status: 'unknown',
      errorCode: null,
      details: null,
      rejectionReason: `Deployment message ${itemHash} was not found on Aleph.`,
      references: []
    }
  }

  const relatedHashes = new Set<string>(rootfsRef ? [rootfsRef] : [])
  for (const referenceHash of extractReferenceHashes(payload.details)) {
    relatedHashes.add(referenceHash)
  }

  const references = await Promise.all(Array.from(relatedHashes).map((hash) => fetchReference(hash, apiHost)))
  const status = normalizeMessageStatus(payload.status)
  const errorCode = typeof payload.error_code === 'number' ? payload.error_code : null
  const details = payload.details && typeof payload.details === 'object' ? (payload.details as Record<string, unknown>) : null

  return {
    status,
    errorCode,
    details,
    rejectionReason: status === 'rejected' ? describeRejectedDeployment(payload, references, rootfsRef) : null,
    references
  }
}

export async function waitForDeploymentResult(
  itemHash: string,
  rootfsRef?: string,
  apiHost = DEFAULT_ALEPH_API_HOST,
  attempts = 15,
  delayMs = 2000
): Promise<DeploymentInspectionResult> {
  let lastResult = await inspectDeploymentResult(itemHash, rootfsRef, apiHost)

  for (let attempt = 1; attempt < attempts; attempt += 1) {
    if (lastResult.status === 'processed' || lastResult.status === 'rejected') {
      return lastResult
    }

    await new Promise((resolve) => globalThis.setTimeout(resolve, delayMs))
    lastResult = await inspectDeploymentResult(itemHash, rootfsRef, apiHost)
  }

  return lastResult
}

function isInvalidMessageFormatResponse(response: Response, payload: AlephBroadcastResponse): boolean {
  if (response.status !== 422) return false

  const details = payload.details
  if (typeof details === 'string' && details.includes('InvalidMessageFormat')) return true
  if (details && typeof details === 'object') {
    const detailMessage = (details as { message?: unknown }).message
    if (typeof detailMessage === 'string' && detailMessage.includes('InvalidMessageFormat')) return true
  }

  return false
}

async function postBroadcastPayload(
  body: Record<string, unknown>,
  apiHost: string
): Promise<{ response: AlephBroadcastResponse; httpStatus: number; rawResponse: Response }> {
  const rawResponse = await fetchWithTimeout(`${apiHost}/api/v0/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })

  const response = (await rawResponse.json().catch(() => ({}))) as AlephBroadcastResponse
  return {
    response,
    httpStatus: rawResponse.status,
    rawResponse
  }
}

export async function broadcastInstanceMessage(
  message: AlephBroadcastMessage,
  apiHost = DEFAULT_ALEPH_API_HOST,
  sync = false
): Promise<BroadcastResult> {
  const attempts: Array<Record<string, unknown>> = [{ sync, message }, { ...message, sync }, { ...message }]

  for (let index = 0; index < attempts.length; index += 1) {
    const result = await postBroadcastPayload(attempts[index], apiHost)
    if (result.rawResponse.ok || result.httpStatus === 202) {
      return {
        response: result.response,
        httpStatus: result.httpStatus
      }
    }

    const canRetry =
      index < attempts.length - 1 && isInvalidMessageFormatResponse(result.rawResponse, result.response)
    if (!canRetry) {
      throw new Error(`Broadcast failed: ${result.httpStatus} ${JSON.stringify(result.response)}`)
    }
  }

  throw new Error('Broadcast failed: no compatible request format was accepted')
}

export async function broadcastAlephMessage(
  message: AlephBroadcastMessage,
  apiHost = DEFAULT_ALEPH_API_HOST,
  sync = false
): Promise<BroadcastResult> {
  return broadcastInstanceMessage(message, apiHost, sync)
}
