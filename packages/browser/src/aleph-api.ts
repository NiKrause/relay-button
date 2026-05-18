import { fetchWithTimeout } from './http'
import type {
  AlephMessageEnvelope,
  AlephBroadcastMessage,
  AlephBroadcastResponse,
  BalanceResponse,
  BroadcastResult,
  Crn,
  CrnListResponse,
  DeploymentInspectionResult,
  InstanceMessage,
  MessageReference,
  MessageStatus
} from './types'

export const DEFAULT_ALEPH_API_HOST = 'https://api2.aleph.im'
export const DEFAULT_CRN_LIST_URL = 'https://crns-list.aleph.sh/crns.json'

export function normalizeMessageStatus(status: unknown): MessageStatus {
  if (typeof status !== 'string') return 'unknown'

  const normalized = status.toLowerCase()
  if (normalized === 'processed' || normalized === 'pending' || normalized === 'rejected') {
    return normalized
  }

  return 'unknown'
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
  url.searchParams.set('message_statuses', 'processed,pending,rejected,removing')
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
          : message.status
  }))
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
