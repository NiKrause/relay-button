import type {
  InstanceExecution,
  MessageReference,
  MessageStatus
} from '@shared-aleph/shared-types'

type MessageEnvelope = {
  status?: unknown
  type?: unknown
  error_code?: unknown
  details?: unknown
  message?: { type?: unknown } | null
  messages?: Array<{ type?: unknown }> | null
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

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function normalizeMessageStatus(status: unknown): MessageStatus {
  if (typeof status !== 'string') return 'unknown'

  const normalized = status.toLowerCase()
  if (normalized === 'processed' || normalized === 'pending' || normalized === 'rejected') {
    return normalized
  }

  return 'unknown'
}

export function normalizeProxyUrl(value: unknown): string | null {
  const stringValue = asString(value)
  if (!stringValue) return null
  if (/^https?:\/\//i.test(stringValue)) return stringValue
  return `https://${stringValue}`
}

export function messageTypeFromEnvelope(payload: MessageEnvelope | null): string | null {
  if (!payload) return null

  const type =
    payload.type ??
    payload.message?.type ??
    (Array.isArray(payload.messages) ? payload.messages[0]?.type : undefined)

  return typeof type === 'string' ? type.toUpperCase() : null
}

export function extractReferenceHashes(details: unknown): string[] {
  if (!details || typeof details !== 'object' || !('errors' in details)) return []

  const errors = (details as { errors?: unknown }).errors
  if (!Array.isArray(errors)) return []

  return errors.filter((value): value is string => typeof value === 'string')
}

export function describeRejectedDeployment(
  payload: MessageEnvelope,
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

  const referencedHashes = extractReferenceHashes(payload.details)
  if (referencedHashes.length > 0) {
    return `Aleph rejected this deployment${errorCode ? ` (error ${errorCode})` : ''}. Referenced message(s): ${referencedHashes.join(', ')}.`
  }

  return `Aleph rejected this deployment${errorCode ? ` (error ${errorCode})` : ''}.`
}

export function extractProxyUrl(item: CrnExecutionV2Payload, networking: CrnExecutionV2Payload['networking']): string | null {
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

  const webAccessCandidates = [item.web_access, item.webAccess]
  for (const entry of webAccessCandidates) {
    const normalized =
      normalizeProxyUrl(entry?.url) ??
      normalizeProxyUrl(entry?.proxy_url) ??
      normalizeProxyUrl(entry?.hostname) ??
      normalizeProxyUrl(entry?.domain)

    if (normalized) return normalized
  }

  return null
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
