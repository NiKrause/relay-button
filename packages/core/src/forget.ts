import type { AlephBroadcastMessage, MessageHasher, MessageSigner } from '@shared-aleph/shared-types'

import { broadcastAlephMessage, normalizeBroadcastStatus, type JsonFetchLike, signAlephMessage } from './broadcast.ts'

export const DEFAULT_ALEPH_CHANNEL = 'TEST'

function asOptionalReason(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export async function createUnsignedForgetMessage(args: {
  sender: string
  hashes?: string[]
  aggregates?: string[]
  reason?: string
  hasher: MessageHasher
  channel?: string
  now?: number
}): Promise<Omit<AlephBroadcastMessage, 'signature'>> {
  const content = {
    address: args.sender,
    time: args.now ?? Date.now() / 1000,
    hashes: [...new Set((args.hashes ?? []).filter(Boolean))],
    aggregates: [...new Set((args.aggregates ?? []).filter(Boolean))],
    reason: asOptionalReason(args.reason)
  }

  if (content.hashes.length === 0 && content.aggregates.length === 0) {
    throw new Error('FORGET message requires at least one hash or aggregate key.')
  }

  const itemContent = JSON.stringify(content)
  const itemHash = await args.hasher(itemContent)

  return {
    sender: args.sender,
    chain: 'ETH',
    type: 'FORGET',
    item_hash: itemHash,
    item_type: 'inline',
    item_content: itemContent,
    time: args.now ?? Date.now() / 1000,
    channel: args.channel ?? DEFAULT_ALEPH_CHANNEL
  }
}

export async function forgetAlephMessages(args: {
  sender: string
  hashes?: string[]
  aggregates?: string[]
  reason?: string
  signer: MessageSigner
  hasher: MessageHasher
  fetch: JsonFetchLike
  channel?: string
  apiHost?: string
  sync?: boolean
  now?: number
}) {
  const unsignedMessage = await createUnsignedForgetMessage({
    sender: args.sender,
    hashes: args.hashes,
    aggregates: args.aggregates,
    reason: args.reason,
    hasher: args.hasher,
    channel: args.channel,
    now: args.now
  })
  const message = await signAlephMessage(unsignedMessage, args.signer)
  const { response, httpStatus } = await broadcastAlephMessage(message, {
    apiHost: args.apiHost,
    sync: args.sync,
    fetch: args.fetch
  })

  return {
    sender: args.sender,
    itemHash: message.item_hash,
    response,
    httpStatus,
    status: normalizeBroadcastStatus(httpStatus, response?.message_status)
  }
}

export async function cleanupFailedDeployment(args: {
  sender: string
  instanceItemHash: string
  reason?: string
  signer: MessageSigner
  hasher: MessageHasher
  fetch: JsonFetchLike
  channel?: string
  apiHost?: string
}) {
  try {
    return await forgetAlephMessages({
      sender: args.sender,
      hashes: [args.instanceItemHash],
      reason: args.reason ?? 'Discard failed deployment attempt',
      signer: args.signer,
      hasher: args.hasher,
      fetch: args.fetch,
      channel: args.channel,
      apiHost: args.apiHost
    })
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
