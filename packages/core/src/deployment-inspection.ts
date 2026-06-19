import type {
  DeploymentInspectionResult,
  MessageInspectionResult,
  MessageReference
} from '@le-space/shared-types'

import { DEFAULT_ALEPH_API_HOST, type FetchLike } from './manifests.ts'
import {
  describeRejectedDeployment,
  extractInsufficientBalanceMessage,
  extractReferenceHashes,
  messageTypeFromEnvelope,
  normalizeMessageStatus
} from './aleph-normalizers.ts'

type MessageEnvelope = {
  status?: unknown
  type?: unknown
  error_code?: unknown
  details?: unknown
  message?: { type?: unknown } | null
  messages?: Array<{ type?: unknown }> | null
}

const TRANSIENT_MESSAGE_LOOKUP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504])

export function isTransientMessageLookupError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const match = message.match(/Message lookup failed: (\d{3})/)
  if (!match) return false

  return TRANSIENT_MESSAGE_LOOKUP_STATUSES.has(Number(match[1]))
}

export async function fetchMessageEnvelope(
  itemHash: string,
  options: {
    apiHost?: string
    fetch: FetchLike
  }
): Promise<MessageEnvelope | null> {
  const response = await options.fetch(`${options.apiHost ?? DEFAULT_ALEPH_API_HOST}/api/v0/messages/${itemHash}`, {
    cache: 'no-cache'
  })

  if (response.status === 404) return null
  if (!response.ok) throw new Error(`Message lookup failed: ${response.status}`)

  return (await response.json()) as MessageEnvelope
}

export async function inspectMessageResult(
  itemHash: string,
  options: {
    apiHost?: string
    fetch: FetchLike
    label?: string
  }
): Promise<MessageInspectionResult> {
  const label = options.label ?? 'Message'
  const payload = await fetchMessageEnvelope(itemHash, options)
  if (!payload) {
    return {
      status: 'unknown',
      errorCode: null,
      details: null,
      rejectionReason: `${label} ${itemHash} was not found on Aleph.`
    }
  }

  const status = normalizeMessageStatus(payload.status)
  const errorCode = typeof payload.error_code === 'number' ? payload.error_code : null
  const details = payload.details && typeof payload.details === 'object' ? (payload.details as Record<string, unknown>) : null
  let rejectionReason = null

  if (status === 'rejected') {
    const balanceMessage = extractInsufficientBalanceMessage(details)
    rejectionReason = balanceMessage
      ? `${label} ${itemHash} was rejected by Aleph due to ${balanceMessage}.`
      : `${label} ${itemHash} was rejected by Aleph${errorCode ? ` (error ${errorCode})` : ''}.`
  }

  return {
    status,
    errorCode,
    details,
    rejectionReason
  }
}

async function fetchReference(
  itemHash: string,
  options: {
    apiHost?: string
    fetch: FetchLike
  }
): Promise<MessageReference> {
  const payload = await fetchMessageEnvelope(itemHash, options)
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
  options: {
    rootfsRef?: string
    apiHost?: string
    fetch: FetchLike
  }
): Promise<DeploymentInspectionResult> {
  const payload = await fetchMessageEnvelope(itemHash, options)
  if (!payload) {
    return {
      status: 'unknown',
      errorCode: null,
      details: null,
      rejectionReason: `Deployment message ${itemHash} was not found on Aleph.`,
      references: []
    }
  }

  const relatedHashes = new Set<string>(options.rootfsRef ? [options.rootfsRef] : [])
  for (const referenceHash of extractReferenceHashes(payload.details)) {
    relatedHashes.add(referenceHash)
  }

  const references = await Promise.all(
    Array.from(relatedHashes).map((hash) => fetchReference(hash, options))
  )
  const status = normalizeMessageStatus(payload.status)
  const errorCode = typeof payload.error_code === 'number' ? payload.error_code : null
  const details = payload.details && typeof payload.details === 'object' ? (payload.details as Record<string, unknown>) : null

  return {
    status,
    errorCode,
    details,
    rejectionReason: status === 'rejected' ? describeRejectedDeployment(payload, references, options.rootfsRef) : null,
    references
  }
}

export async function waitForDeploymentResult(
  itemHash: string,
  options: {
    rootfsRef?: string
    apiHost?: string
    fetch: FetchLike
    attempts?: number
    delayMs?: number
    sleep?: (ms: number) => Promise<void>
    onAttempt?: (result: DeploymentInspectionResult, attempt: number, attempts: number) => void
  }
): Promise<DeploymentInspectionResult> {
  const attempts = Math.max(1, Number(options.attempts ?? 15))
  const delayMs = Math.max(0, Number(options.delayMs ?? 2000))
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))

  let lastResult: DeploymentInspectionResult = {
    status: 'unknown',
    errorCode: null,
    details: null,
    rejectionReason: null,
    references: []
  }

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      lastResult = await inspectDeploymentResult(itemHash, options)
    } catch (error) {
      if (!isTransientMessageLookupError(error)) {
        throw error
      }
      lastResult = {
        ...lastResult,
        rejectionReason: error instanceof Error ? error.message : String(error)
      }
    }
    options.onAttempt?.(lastResult, attempt, attempts)
    if (lastResult.status === 'processed' || lastResult.status === 'rejected') {
      return lastResult
    }
    if (attempt < attempts) {
      await sleep(delayMs)
    }
  }

  return lastResult
}
