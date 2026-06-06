import type {
  AlephAggregateContent,
  AlephBroadcastMessage,
  MessageHasher,
  MessageSigner,
  MessageStatus,
  VmBootstrapConfigAggregate,
  VmBootstrapConfigRecord,
} from '@le-space/shared-types'

import { broadcastAlephMessage, signAlephMessage, type JsonFetchLike } from './broadcast.ts'
import { DEFAULT_ALEPH_CHANNEL } from './constants.ts'
import { DEFAULT_ALEPH_API_HOST } from './manifests.ts'

export const VM_BOOTSTRAP_CONFIG_AGGREGATE_KEY = 'vm-bootstrap-config'

export async function fetchVmBootstrapConfigAggregate(
  address: string,
  options: {
    apiHost?: string
    fetch: JsonFetchLike
  }
): Promise<VmBootstrapConfigAggregate> {
  const requestUrl = new URL(`/api/v0/aggregates/${address}.json`, options.apiHost ?? DEFAULT_ALEPH_API_HOST)
  requestUrl.searchParams.set('keys', VM_BOOTSTRAP_CONFIG_AGGREGATE_KEY)

  const response = await options.fetch(requestUrl.toString(), { cache: 'no-cache' })
  if (response.status === 404) return {}
  if (!response.ok) {
    throw new Error(`VM bootstrap config aggregate request failed: ${response.status}`)
  }

  const payload = (await response.json()) as { data?: Record<string, unknown> }
  const aggregate = payload.data?.[VM_BOOTSTRAP_CONFIG_AGGREGATE_KEY]
  if (!aggregate || typeof aggregate !== 'object' || Array.isArray(aggregate)) return {}
  return aggregate as VmBootstrapConfigAggregate
}

function normalizeVmBootstrapConfigAggregate(
  aggregate: VmBootstrapConfigAggregate | null | undefined,
): VmBootstrapConfigAggregate {
  if (!aggregate || typeof aggregate !== 'object') return {}
  return Object.fromEntries(
    Object.entries(aggregate).filter(
      (entry): entry is [string, VmBootstrapConfigRecord] =>
        Boolean(entry[1] && typeof entry[1] === 'object' && !Array.isArray(entry[1])),
    ),
  )
}

export function createVmBootstrapConfigAggregateContent(args: {
  sender: string
  record: VmBootstrapConfigRecord
  existingAggregate?: VmBootstrapConfigAggregate | null
  now?: number
}): AlephAggregateContent<VmBootstrapConfigAggregate> {
  const content = normalizeVmBootstrapConfigAggregate(args.existingAggregate)
  content[args.record.deploymentToken] = args.record

  return {
    address: args.sender,
    key: VM_BOOTSTRAP_CONFIG_AGGREGATE_KEY,
    content,
    time: args.now ?? Date.now() / 1000,
  }
}

async function createUnsignedVmBootstrapConfigAggregateMessage(args: {
  sender: string
  content: AlephAggregateContent<VmBootstrapConfigAggregate>
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
    channel: args.channel ?? DEFAULT_ALEPH_CHANNEL,
  }
}

async function publishVmBootstrapConfigAggregate(args: {
  sender: string
  content: AlephAggregateContent<VmBootstrapConfigAggregate>
  signer: MessageSigner
  hasher: MessageHasher
  fetch: JsonFetchLike
  channel?: string
  apiHost?: string
  sync?: boolean
}): Promise<{ aggregateItemHash: string; aggregateStatus: MessageStatus }> {
  const unsignedMessage = await createUnsignedVmBootstrapConfigAggregateMessage({
    sender: args.sender,
    content: args.content,
    hasher: args.hasher,
    channel: args.channel,
  })
  const message = await signAlephMessage(unsignedMessage, args.signer)
  const { response, httpStatus } = await broadcastAlephMessage(message, {
    apiHost: args.apiHost,
    sync: args.sync,
    fetch: args.fetch,
  })
  const aggregateStatus = httpStatus >= 200 && httpStatus < 300
    ? ((response.message_status as MessageStatus | undefined) ?? 'processed')
    : 'unknown'

  if (aggregateStatus === 'rejected') {
    throw new Error(`VM bootstrap config aggregate was rejected by Aleph: ${JSON.stringify(response.details ?? response)}`)
  }

  return {
    aggregateItemHash: message.item_hash,
    aggregateStatus,
  }
}

export async function publishVmBootstrapConfig(args: {
  sender: string
  record: VmBootstrapConfigRecord
  signer: MessageSigner
  hasher: MessageHasher
  fetch: JsonFetchLike
  channel?: string
  apiHost?: string
  sync?: boolean
}): Promise<{
  aggregateItemHash: string
  aggregateStatus: MessageStatus
  aggregate: VmBootstrapConfigAggregate
}> {
  const aggregate = await fetchVmBootstrapConfigAggregate(args.sender, {
    apiHost: args.apiHost,
    fetch: args.fetch,
  })

  const content = createVmBootstrapConfigAggregateContent({
    sender: args.sender,
    record: args.record,
    existingAggregate: aggregate,
  })

  const result = await publishVmBootstrapConfigAggregate({
    sender: args.sender,
    content,
    signer: args.signer,
    hasher: args.hasher,
    fetch: args.fetch,
    channel: args.channel,
    apiHost: args.apiHost,
    sync: args.sync,
  })

  return {
    ...result,
    aggregate: content.content,
  }
}

export async function deleteVmBootstrapConfig(args: {
  sender: string
  deploymentToken: string
  signer: MessageSigner
  hasher: MessageHasher
  fetch: JsonFetchLike
  channel?: string
  apiHost?: string
  sync?: boolean
}): Promise<{
  aggregateItemHash: string
  aggregateStatus: MessageStatus
  aggregate: VmBootstrapConfigAggregate
}> {
  const aggregate = await fetchVmBootstrapConfigAggregate(args.sender, {
    apiHost: args.apiHost,
    fetch: args.fetch,
  })

  const content = normalizeVmBootstrapConfigAggregate(aggregate)
  delete content[args.deploymentToken]

  const publishResult = await publishVmBootstrapConfigAggregate({
    sender: args.sender,
    content: {
      address: args.sender,
      key: VM_BOOTSTRAP_CONFIG_AGGREGATE_KEY,
      content,
      time: Date.now() / 1000,
    },
    signer: args.signer,
    hasher: args.hasher,
    fetch: args.fetch,
    channel: args.channel,
    apiHost: args.apiHost,
    sync: args.sync,
  })

  return {
    ...publishResult,
    aggregate: content,
  }
}
