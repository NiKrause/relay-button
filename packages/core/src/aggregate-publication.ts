import type {
  AlephAggregateContent,
  AlephBroadcastMessage,
  MessageHasher,
  MessageSigner,
  MessageStatus,
  PortForwardAggregate,
  RootfsManifest,
  RootfsRequiredPortForward
} from '@shared-aleph/shared-types'

import { broadcastAlephMessage, normalizeBroadcastStatus, signAlephMessage, type JsonFetchLike } from './broadcast.ts'
import {
  fetchPortForwardAggregate,
  mergePortFlagMaps,
  normalizeExistingPortForwardEntry,
  requestedPortFlags,
  requiredInstancePortForwards
} from './port-forwarding.ts'

export const DEFAULT_ALEPH_CHANNEL = 'TEST'

export function createPortForwardAggregateContent(args: {
  sender: string
  instanceItemHash: string
  requestedPorts: ReadonlyArray<RootfsRequiredPortForward>
  existingAggregate?: PortForwardAggregate
  now?: number
}): AlephAggregateContent<PortForwardAggregate> {
  const existingPorts = normalizeExistingPortForwardEntry(args.existingAggregate?.[args.instanceItemHash])
  const mergedPorts = mergePortFlagMaps(existingPorts, requestedPortFlags(args.requestedPorts))

  return {
    address: args.sender,
    key: 'port-forwarding',
    content: {
      [args.instanceItemHash]: {
        ports: mergedPorts
      }
    },
    time: args.now ?? Date.now() / 1000
  }
}

export async function createUnsignedAggregateMessage(args: {
  sender: string
  content: AlephAggregateContent<PortForwardAggregate>
  hasher: MessageHasher
  channel?: string
  now?: number
}): Promise<Omit<AlephBroadcastMessage, 'signature'>> {
  const itemContent = JSON.stringify(args.content)
  const itemHash = await args.hasher(itemContent)

  return {
    sender: args.sender,
    chain: 'ETH',
    type: 'AGGREGATE',
    item_hash: itemHash,
    item_type: 'inline',
    item_content: itemContent,
    time: args.now ?? Date.now() / 1000,
    channel: args.channel ?? DEFAULT_ALEPH_CHANNEL
  }
}

export async function ensureInstancePortForwards(args: {
  sender: string
  instanceItemHash: string
  manifest: RootfsManifest | null
  signer: MessageSigner
  hasher: MessageHasher
  fetch: JsonFetchLike
  channel?: string
  apiHost?: string
  sync?: boolean
}): Promise<{
  aggregateItemHash: string
  aggregateStatus: MessageStatus
  requestedPorts: RootfsRequiredPortForward[]
}> {
  const requestedPorts = requiredInstancePortForwards(args.manifest)
  const aggregate = await fetchPortForwardAggregate(args.sender, {
    apiHost: args.apiHost,
    fetch: args.fetch
  })

  const content = createPortForwardAggregateContent({
    sender: args.sender,
    instanceItemHash: args.instanceItemHash,
    requestedPorts,
    existingAggregate: aggregate
  })

  const unsignedMessage = await createUnsignedAggregateMessage({
    sender: args.sender,
    content,
    hasher: args.hasher,
    channel: args.channel
  })
  const message = await signAlephMessage(unsignedMessage, args.signer)
  const { response, httpStatus } = await broadcastAlephMessage(message, {
    apiHost: args.apiHost,
    sync: args.sync,
    fetch: args.fetch
  })
  const aggregateStatus = normalizeBroadcastStatus(httpStatus, response.message_status)

  if (aggregateStatus === 'rejected') {
    throw new Error(`Port-forward aggregate was rejected by Aleph: ${JSON.stringify(response.details ?? response)}`)
  }

  return {
    aggregateItemHash: message.item_hash,
    aggregateStatus,
    requestedPorts
  }
}
