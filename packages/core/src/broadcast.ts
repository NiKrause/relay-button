import type {
  AlephBroadcastMessage,
  AlephBroadcastResponse,
  MessageSigner,
  MessageStatus
} from '@shared-aleph/shared-types'

import { DEFAULT_ALEPH_API_HOST, type FetchLike } from './manifests.ts'
import { normalizeMessageStatus } from './aleph-normalizers.ts'

export interface JsonFetchLikeResponse {
  ok: boolean
  status: number
  json(): Promise<unknown>
}

export type JsonFetchLike = (url: string, init?: RequestInit) => Promise<JsonFetchLikeResponse>

export function signaturePayload(
  message: Pick<AlephBroadcastMessage, 'chain' | 'sender' | 'type' | 'item_hash'>
): string {
  return [message.chain, message.sender, message.type, message.item_hash].join('\n')
}

export async function signAlephMessage(
  unsignedMessage: Omit<AlephBroadcastMessage, 'signature'>,
  signer: MessageSigner
): Promise<AlephBroadcastMessage> {
  const signature = await signer(unsignedMessage.sender, signaturePayload(unsignedMessage))
  return {
    ...unsignedMessage,
    signature: signature.startsWith('0x') ? signature : `0x${signature}`
  }
}

export function normalizeBroadcastStatus(httpStatus: number, responseStatus: unknown): MessageStatus {
  if (httpStatus === 202) return 'pending'
  return normalizeMessageStatus(responseStatus)
}

export function isInvalidMessageFormatResponse(
  response: { status: number },
  payload: AlephBroadcastResponse
): boolean {
  if (response.status !== 422) return false

  const details = payload?.details
  if (typeof details === 'string' && details.includes('InvalidMessageFormat')) return true
  if (details && typeof details === 'object') {
    const detailMessage = (details as { message?: unknown }).message
    if (typeof detailMessage === 'string' && detailMessage.includes('InvalidMessageFormat')) return true
  }

  return false
}

export function isRetryableBroadcastFailure(
  response: { status: number },
  payload: AlephBroadcastResponse
): boolean {
  if (response.status >= 500) return true
  const publicationStatus = payload?.publication_status?.status
  if (typeof publicationStatus === 'string' && publicationStatus.toLowerCase() === 'error') {
    return true
  }
  return false
}

export async function postBroadcastPayload(
  body: Record<string, unknown>,
  options: {
    apiHost?: string
    fetch: JsonFetchLike
  }
): Promise<{ response: AlephBroadcastResponse; httpStatus: number }> {
  const rawResponse = await options.fetch(`${options.apiHost ?? DEFAULT_ALEPH_API_HOST}/api/v0/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })

  const response = (await rawResponse.json().catch(() => ({}))) as AlephBroadcastResponse
  return {
    response,
    httpStatus: rawResponse.status
  }
}

export async function broadcastAlephMessage(
  message: AlephBroadcastMessage,
  options: {
    apiHost?: string
    sync?: boolean
    fetch: JsonFetchLike
  }
): Promise<{ response: AlephBroadcastResponse; httpStatus: number }> {
  const attempts: Array<Record<string, unknown>> = [
    { sync: options.sync ?? false, message },
    { ...message, sync: options.sync ?? false },
    { ...message }
  ]

  for (let index = 0; index < attempts.length; index += 1) {
    const result = await postBroadcastPayload(attempts[index], {
      apiHost: options.apiHost,
      fetch: options.fetch
    })

    if (result.httpStatus === 202 || normalizeBroadcastStatus(result.httpStatus, result.response?.message_status) !== 'unknown' || (result.httpStatus >= 200 && result.httpStatus < 300)) {
      return result
    }

    const canRetry =
      index < attempts.length - 1 &&
      (isInvalidMessageFormatResponse({ status: result.httpStatus }, result.response) ||
        isRetryableBroadcastFailure({ status: result.httpStatus }, result.response))
    if (!canRetry) {
      throw new Error(`Broadcast failed: ${result.httpStatus} ${JSON.stringify(result.response ?? {})}`)
    }
  }

  throw new Error('Broadcast failed: no compatible request format was accepted')
}
