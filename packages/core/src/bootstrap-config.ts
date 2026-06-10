import type {
  AlephAggregateContent,
  AlephBroadcastMessage,
  MessageHasher,
  MessageSigner,
  MessageStatus,
  VmBootstrapConfigAggregate,
  VmBootstrapConfigRecord,
  VmBootstrapConfigSignalRecord,
  VmBootstrapConfigSignalType,
} from '@le-space/shared-types'

import { broadcastAlephMessage, signAlephMessage, type JsonFetchLike } from './broadcast.ts'
import { DEFAULT_ALEPH_CHANNEL } from './constants.ts'
import { DEFAULT_ALEPH_API_HOST } from './manifests.ts'

export const VM_BOOTSTRAP_CONFIG_AGGREGATE_KEY = 'vm-bootstrap-config'
export const VM_BOOTSTRAP_CONFIG_SIGNAL_REF = 'vm-bootstrap-config'
export const VM_BOOTSTRAP_CONFIG_SIGNAL_POST_TYPE = 'vm-bootstrap-config-status'

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

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

function normalizeVmBootstrapConfigSignalRecord(
  value: unknown,
): VmBootstrapConfigSignalRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  const deploymentToken =
    typeof candidate.deploymentToken === 'string' ? candidate.deploymentToken.trim() : ''
  const status = typeof candidate.status === 'string' ? candidate.status.trim() : ''
  const profile = typeof candidate.profile === 'string' ? candidate.profile.trim() : ''
  const ownerAddress =
    typeof candidate.ownerAddress === 'string' ? candidate.ownerAddress.trim() : ''
  const instanceItemHash =
    typeof candidate.instanceItemHash === 'string' ? candidate.instanceItemHash.trim() : ''
  const updatedAt =
    typeof candidate.updatedAt === 'string' ? candidate.updatedAt.trim() : ''

  if (!deploymentToken || !status || !profile || !ownerAddress || !instanceItemHash || !updatedAt) {
    return null
  }

  return {
    deploymentToken,
    status: status as VmBootstrapConfigSignalType,
    profile,
    ownerAddress,
    instanceItemHash,
    updatedAt,
    publisherAddress:
      typeof candidate.publisherAddress === 'string' && candidate.publisherAddress.trim()
        ? candidate.publisherAddress.trim()
        : null,
    authorization: candidate.authorization,
  }
}

export async function fetchVmBootstrapConfigSignals(args: {
  deploymentToken?: string
  ownerAddress?: string
  instanceItemHash?: string
  fetch: JsonFetchLike
  apiHost?: string
  ref?: string
  postType?: string
  page?: number
  pagination?: number
}): Promise<VmBootstrapConfigSignalRecord[]> {
  const requestUrl = new URL('/api/v0/posts.json', args.apiHost ?? DEFAULT_ALEPH_API_HOST)
  requestUrl.searchParams.set('refs', args.ref ?? VM_BOOTSTRAP_CONFIG_SIGNAL_REF)
  requestUrl.searchParams.set('types', args.postType ?? VM_BOOTSTRAP_CONFIG_SIGNAL_POST_TYPE)
  requestUrl.searchParams.set('pagination', String(Math.max(1, Number(args.pagination ?? 100))))
  requestUrl.searchParams.set('page', String(Math.max(1, Number(args.page ?? 1))))
  requestUrl.searchParams.set('sortOrder', '-1')

  const response = await args.fetch(requestUrl.toString(), { cache: 'no-cache' })
  if (!response.ok) {
    throw new Error(`VM bootstrap config signal request failed: ${response.status}`)
  }

  const payload = (await response.json()) as { posts?: unknown[] }
  const expectedDeploymentToken = args.deploymentToken?.trim() ?? ''
  const expectedOwnerAddress = args.ownerAddress?.trim().toLowerCase() ?? ''
  const expectedInstanceItemHash = args.instanceItemHash?.trim() ?? ''

  return (payload.posts ?? [])
    .map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
      const parsed =
        'content' in entry &&
          entry.content &&
          typeof entry.content === 'object' &&
          !Array.isArray(entry.content)
          ? entry.content
          : 'item_content' in entry && typeof entry.item_content === 'string'
            ? parseJsonObject(entry.item_content)
            : null
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
      const content =
        'deploymentToken' in parsed
          ? parsed
          : 'content' in parsed &&
              parsed.content &&
              typeof parsed.content === 'object' &&
              !Array.isArray(parsed.content)
            ? parsed.content
            : null
      if (!content || typeof content !== 'object' || Array.isArray(content)) return null
      return normalizeVmBootstrapConfigSignalRecord(content)
    })
    .filter((entry): entry is VmBootstrapConfigSignalRecord => {
      if (!entry) return false
      if (expectedDeploymentToken && entry.deploymentToken !== expectedDeploymentToken) return false
      if (expectedOwnerAddress && entry.ownerAddress.toLowerCase() !== expectedOwnerAddress) return false
      if (expectedInstanceItemHash && entry.instanceItemHash !== expectedInstanceItemHash) return false
      return true
    })
}

export async function waitForVmBootstrapConfigSignal(args: {
  deploymentToken: string
  ownerAddress: string
  instanceItemHash: string
  expectedStatus?: VmBootstrapConfigSignalType
  fetch: JsonFetchLike
  apiHost?: string
  ref?: string
  postType?: string
  attempts?: number
  delayMs?: number
  sleep?: (ms: number) => Promise<void>
}): Promise<VmBootstrapConfigSignalRecord | null> {
  const attempts = Math.max(1, Number(args.attempts ?? 24))
  const delayMs = Math.max(0, Number(args.delayMs ?? 2500))
  const sleep =
    args.sleep ??
    ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const expectedStatus = args.expectedStatus ?? 'applied'

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const signals = await fetchVmBootstrapConfigSignals({
      deploymentToken: args.deploymentToken,
      ownerAddress: args.ownerAddress,
      instanceItemHash: args.instanceItemHash,
      fetch: args.fetch,
      apiHost: args.apiHost,
      ref: args.ref,
      postType: args.postType,
    }).catch(() => [])

    const match = signals.find((entry) => entry.status === expectedStatus) ?? null
    if (match) return match

    if (attempt < attempts - 1) {
      await sleep(delayMs)
    }
  }

  return null
}
