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
export const VM_BOOTSTRAP_CONFIG_HISTORY_RETENTION_MS = 6 * 60 * 60 * 1000

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

function parseTimestampMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? value : value * 1000
  }

  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) {
      return numeric > 1_000_000_000_000 ? numeric : numeric * 1000
    }

    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }

  return null
}

function normalizeVmBootstrapConfigRecord(
  deploymentTokenKey: string,
  value: unknown,
  options: {
    nowMs?: number
    maxRecordAgeMs?: number
  } = {},
): VmBootstrapConfigRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const candidate = value as Record<string, unknown>
  const deploymentToken =
    typeof candidate.deploymentToken === 'string' ? candidate.deploymentToken.trim() : ''
  const profile = typeof candidate.profile === 'string' ? candidate.profile.trim() : ''
  const ownerAddress =
    typeof candidate.ownerAddress === 'string' ? candidate.ownerAddress.trim() : ''
  const instanceItemHash =
    typeof candidate.instanceItemHash === 'string' ? candidate.instanceItemHash.trim() : ''
  const createdAt = typeof candidate.createdAt === 'string' ? candidate.createdAt.trim() : ''
  const expiresAt = typeof candidate.expiresAt === 'string' ? candidate.expiresAt.trim() : ''

  if (
    !deploymentTokenKey.trim() ||
    !deploymentToken ||
    deploymentToken !== deploymentTokenKey.trim() ||
    !profile ||
    !ownerAddress ||
    !instanceItemHash ||
    !createdAt ||
    !expiresAt
  ) {
    return null
  }

  const nowMs = Math.max(0, Number(options.nowMs ?? Date.now()))
  const maxRecordAgeMs = Math.max(
    60_000,
    Number(options.maxRecordAgeMs ?? VM_BOOTSTRAP_CONFIG_HISTORY_RETENTION_MS),
  )
  const createdAtMs = parseTimestampMs(createdAt)
  const expiresAtMs = parseTimestampMs(expiresAt)

  if (createdAtMs == null || expiresAtMs == null) return null
  if (expiresAtMs <= nowMs) return null
  if (createdAtMs < nowMs - maxRecordAgeMs) return null

  return candidate as unknown as VmBootstrapConfigRecord
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
  options: {
    nowMs?: number
    maxRecordAgeMs?: number
  } = {},
): VmBootstrapConfigAggregate {
  if (!aggregate || typeof aggregate !== 'object') return {}
  return Object.fromEntries(
    Object.entries(aggregate)
      .map(([deploymentToken, record]) => [
        deploymentToken,
        normalizeVmBootstrapConfigRecord(deploymentToken, record, options),
      ] as const)
      .filter((entry): entry is [string, VmBootstrapConfigRecord] => entry[1] != null),
  )
}

export function createVmBootstrapConfigAggregateContent(args: {
  sender: string
  record: VmBootstrapConfigRecord
  existingAggregate?: VmBootstrapConfigAggregate | null
  now?: number
  maxRecordAgeMs?: number
}): AlephAggregateContent<VmBootstrapConfigAggregate> {
  const nowMs = Math.max(0, Number(args.now ?? Date.now() / 1000) * 1000)
  const content = normalizeVmBootstrapConfigAggregate(args.existingAggregate, {
    nowMs,
    maxRecordAgeMs: args.maxRecordAgeMs,
  })
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

function normalizeAggregateMessageHashRecord(value: unknown): {
  itemHash: string
  timeMs: number
} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const candidate = value as Record<string, unknown>
  const itemHash = typeof candidate.item_hash === 'string' ? candidate.item_hash.trim() : ''
  if (!itemHash) return null

  const content =
    candidate.content && typeof candidate.content === 'object' && !Array.isArray(candidate.content)
      ? (candidate.content as Record<string, unknown>)
      : typeof candidate.item_content === 'string'
        ? parseJsonObject(candidate.item_content)
        : null
  if (!content || content.key !== VM_BOOTSTRAP_CONFIG_AGGREGATE_KEY) return null

  const timeMs = parseTimestampMs(candidate.time)
  if (timeMs == null) return null

  return { itemHash, timeMs }
}

export async function listStaleVmBootstrapConfigAggregateMessageHashes(args: {
  address: string
  currentAggregateItemHash?: string | null
  olderThanMs?: number
  fetch: JsonFetchLike
  apiHost?: string
  pagination?: number
  maxPages?: number
  nowMs?: number
}): Promise<string[]> {
  const address = args.address.trim()
  if (!address) return []

  const currentAggregateItemHash = args.currentAggregateItemHash?.trim() ?? ''
  const olderThanMs = Math.max(
    60_000,
    Number(args.olderThanMs ?? VM_BOOTSTRAP_CONFIG_HISTORY_RETENTION_MS),
  )
  const cutoffMs = Math.max(0, Number(args.nowMs ?? Date.now()) - olderThanMs)
  const pagination = Math.max(1, Number(args.pagination ?? 100))
  const maxPages = Math.max(1, Number(args.maxPages ?? 10))
  const hashes = new Set<string>()

  for (let page = 1; page <= maxPages; page += 1) {
    const requestUrl = new URL('/api/v0/messages.json', args.apiHost ?? DEFAULT_ALEPH_API_HOST)
    requestUrl.searchParams.set('msgType', 'AGGREGATE')
    requestUrl.searchParams.set('addresses', address)
    requestUrl.searchParams.set('message_statuses', 'processed,pending,rejected')
    requestUrl.searchParams.set('pagination', String(pagination))
    requestUrl.searchParams.set('page', String(page))
    requestUrl.searchParams.set('sortOrder', '-1')

    const response = await args.fetch(requestUrl.toString(), { cache: 'no-cache' })
    if (!response.ok) {
      throw new Error(`VM bootstrap config aggregate history request failed: ${response.status}`)
    }

    const payload = (await response.json()) as { messages?: unknown[] }
    const messages = Array.isArray(payload.messages) ? payload.messages : []
    if (messages.length === 0) break

    for (const message of messages) {
      const normalized = normalizeAggregateMessageHashRecord(message)
      if (!normalized) continue
      if (normalized.itemHash === currentAggregateItemHash) continue
      if (normalized.timeMs > cutoffMs) continue
      hashes.add(normalized.itemHash)
    }

    if (messages.length < pagination) break
  }

  return [...hashes]
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
    maxRecordAgeMs: VM_BOOTSTRAP_CONFIG_HISTORY_RETENTION_MS,
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

  const content = normalizeVmBootstrapConfigAggregate(aggregate, {
    maxRecordAgeMs: VM_BOOTSTRAP_CONFIG_HISTORY_RETENTION_MS,
  })
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
    peerId:
      typeof candidate.peerId === 'string' && candidate.peerId.trim()
        ? candidate.peerId.trim()
        : null,
    probeMultiaddrs: Array.isArray(candidate.probeMultiaddrs)
      ? candidate.probeMultiaddrs.filter(
          (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0
        )
      : [],
    browserBootstrapMultiaddrs: Array.isArray(candidate.browserBootstrapMultiaddrs)
      ? candidate.browserBootstrapMultiaddrs.filter(
          (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0
        )
      : [],
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
