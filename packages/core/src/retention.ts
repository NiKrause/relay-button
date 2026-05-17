import type {
  AlephAggregateContent,
  AlephBroadcastMessage,
  MessageHasher,
  MessageSigner
} from '@shared-aleph/shared-types'

import { broadcastAlephMessage, normalizeBroadcastStatus, type JsonFetchLike, signAlephMessage } from './broadcast.ts'
import { DEFAULT_ALEPH_CHANNEL } from './constants.ts'
import { forgetAlephMessages } from './forget.ts'

export const SUCCESSFUL_DEPLOYMENTS_AGGREGATE_KEY = 'uc-go-peer-successful-deployments'

export interface RetentionRecord {
  instance_item_hash: string
  rootfs_item_hash: string
  site_item_hash: string
  rootfs_cid: string
  site_url: string
  relay_peer_id: string
  rootfs_version: string
  deployed_at: string
  vm_name: string
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function normalizeRetentionRecord(record: unknown): RetentionRecord | null {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null
  const candidate = record as Record<string, unknown>
  const instanceItemHash = asString(candidate.instance_item_hash)
  if (!instanceItemHash) return null

  return {
    instance_item_hash: instanceItemHash,
    rootfs_item_hash: asString(candidate.rootfs_item_hash) ?? '',
    site_item_hash: asString(candidate.site_item_hash) ?? '',
    rootfs_cid: asString(candidate.rootfs_cid) ?? '',
    site_url: asString(candidate.site_url) ?? '',
    relay_peer_id: asString(candidate.relay_peer_id) ?? '',
    rootfs_version: asString(candidate.rootfs_version) ?? '',
    deployed_at: asString(candidate.deployed_at) ?? new Date().toISOString(),
    vm_name: asString(candidate.vm_name) ?? ''
  }
}

function normalizeRetentionLedger(value: unknown): RetentionRecord[] {
  if (Array.isArray(value)) {
    return value.map(normalizeRetentionRecord).filter((entry): entry is RetentionRecord => entry != null)
  }

  if (value && typeof value === 'object' && Array.isArray((value as { deployments?: unknown[] }).deployments)) {
    return ((value as { deployments: unknown[] }).deployments)
      .map(normalizeRetentionRecord)
      .filter((entry): entry is RetentionRecord => entry != null)
  }

  return []
}

function retentionRecordId(record: RetentionRecord): string {
  return [record.instance_item_hash, record.rootfs_item_hash, record.site_item_hash].join(':')
}

function hashesFromRetentionRecord(record: RetentionRecord): string[] {
  return [record.instance_item_hash, record.rootfs_item_hash, record.site_item_hash].filter(Boolean)
}

export async function fetchAggregateKey(args: {
  address: string
  key: string
  fetch: JsonFetchLike
  apiHost?: string
}): Promise<unknown> {
  const requestUrl = new URL(`/api/v0/aggregates/${args.address}.json`, args.apiHost ?? 'https://api2.aleph.im')
  requestUrl.searchParams.set('keys', args.key)

  const response = await args.fetch(requestUrl.toString(), { cache: 'no-cache' })
  if (response.status === 404) return {}
  if (!response.ok) {
    throw new Error(`Aggregate request failed for key ${args.key}: ${response.status}`)
  }

  const payload = (await response.json()) as { data?: Record<string, unknown> }
  return payload?.data?.[args.key] ?? {}
}

async function createUnsignedAggregateMessage(args: {
  sender: string
  content: AlephAggregateContent<Record<string, unknown>>
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

export async function publishAggregateKey(args: {
  sender: string
  key: string
  content: Record<string, unknown>
  signer: MessageSigner
  hasher: MessageHasher
  fetch: JsonFetchLike
  channel?: string
  apiHost?: string
  now?: number
}) {
  const aggregateContent: AlephAggregateContent<Record<string, unknown>> = {
    address: args.sender,
    key: args.key,
    content: args.content,
    time: args.now ?? Date.now() / 1000
  }

  const unsignedMessage = await createUnsignedAggregateMessage({
    sender: args.sender,
    content: aggregateContent,
    hasher: args.hasher,
    channel: args.channel,
    now: args.now
  })
  const message = await signAlephMessage(unsignedMessage, args.signer)
  const { response, httpStatus } = await broadcastAlephMessage(message, {
    apiHost: args.apiHost,
    sync: true,
    fetch: args.fetch
  })

  return {
    itemHash: message.item_hash,
    status: normalizeBroadcastStatus(httpStatus, response?.message_status),
    response,
    httpStatus
  }
}

async function fetchMessageStatus(args: {
  hash: string
  fetch: JsonFetchLike
  apiHost?: string
}): Promise<string> {
  const requestUrl = new URL(`/api/v0/messages/${args.hash}`, args.apiHost ?? 'https://api2.aleph.im')
  const response = await args.fetch(requestUrl.toString(), { cache: 'no-cache' })
  if (response.status === 404) return 'missing'
  if (!response.ok) return 'unknown'

  const payload = (await response.json()) as { status?: unknown }
  return asString(payload?.status) ?? 'unknown'
}

async function classifyForgetHashes(args: {
  hashes: string[]
  fetch: JsonFetchLike
  apiHost?: string
}): Promise<{ forgottenHashes: string[]; outstandingForgetHashes: string[]; statuses: Record<string, string> }> {
  const statuses: Record<string, string> = {}
  for (const hash of args.hashes) {
    statuses[hash] = await fetchMessageStatus({
      hash,
      fetch: args.fetch,
      apiHost: args.apiHost
    })
  }

  const forgottenHashes = args.hashes.filter((hash) => statuses[hash] === 'forgotten')
  const outstandingForgetHashes = args.hashes.filter((hash) => statuses[hash] !== 'forgotten')
  return {
    forgottenHashes,
    outstandingForgetHashes,
    statuses
  }
}

export async function retainSuccessfulDeployments(args: {
  sender: string
  currentRecord: unknown
  keepCount: number
  signer: MessageSigner
  hasher: MessageHasher
  fetch: JsonFetchLike
  aggregateKey?: string
  extraForgetHashes?: string[]
  reason?: string
  channel?: string
  apiHost?: string
  now?: number
}) {
  const keepCount = Math.max(0, Number.parseInt(String(args.keepCount ?? 0), 10) || 0)
  const aggregateKey = asString(args.aggregateKey) ?? SUCCESSFUL_DEPLOYMENTS_AGGREGATE_KEY
  const currentRecord = normalizeRetentionRecord(args.currentRecord)

  if (!currentRecord) {
    throw new Error('retainSuccessfulDeployments requires a current deployment record with instance_item_hash.')
  }

  const existingValue = await fetchAggregateKey({
    address: args.sender,
    key: aggregateKey,
    fetch: args.fetch,
    apiHost: args.apiHost
  })
  const existingRecords = normalizeRetentionLedger(existingValue)
  const mergedRecords = [currentRecord, ...existingRecords]
  const uniqueRecords: RetentionRecord[] = []
  const seenIds = new Set<string>()

  for (const record of mergedRecords) {
    const id = retentionRecordId(record)
    if (seenIds.has(id)) continue
    seenIds.add(id)
    uniqueRecords.push(record)
  }

  const retainedRecords = keepCount > 0 ? uniqueRecords.slice(0, keepCount) : []
  const prunedRecords = keepCount > 0 ? uniqueRecords.slice(keepCount) : uniqueRecords
  const retainedHashes = new Set(retainedRecords.flatMap(hashesFromRetentionRecord))
  const extraForgetHashes = [...new Set((args.extraForgetHashes ?? []).filter(Boolean))]
  const forgetHashes = [...new Set([...prunedRecords.flatMap(hashesFromRetentionRecord), ...extraForgetHashes])].filter(
    (hash) => !retainedHashes.has(hash)
  )

  const aggregateContent = {
    keep: keepCount,
    updated_at: new Date().toISOString(),
    deployments: retainedRecords
  }

  const aggregatePublication = await publishAggregateKey({
    sender: args.sender,
    key: aggregateKey,
    content: aggregateContent,
    signer: args.signer,
    hasher: args.hasher,
    fetch: args.fetch,
    channel: args.channel,
    apiHost: args.apiHost,
    now: args.now
  })

  let forgetResult = null
  let followUpForgetResults: Array<{ hash: string; result: Awaited<ReturnType<typeof forgetAlephMessages>> }> = []
  let forgottenHashes: string[] = []
  let outstandingForgetHashes: string[] = []
  let forgetStatuses: Record<string, string> = {}

  if (forgetHashes.length > 0) {
    const initiallyOutstanding = await classifyForgetHashes({
      hashes: forgetHashes,
      fetch: args.fetch,
      apiHost: args.apiHost
    })

    forgottenHashes = initiallyOutstanding.forgottenHashes
    outstandingForgetHashes = initiallyOutstanding.outstandingForgetHashes
    forgetStatuses = initiallyOutstanding.statuses

    if (outstandingForgetHashes.length > 0) {
      forgetResult = await forgetAlephMessages({
        sender: args.sender,
        hashes: outstandingForgetHashes,
        reason: args.reason ?? `Prune successful deployments beyond retention limit ${keepCount}`,
        signer: args.signer,
        hasher: args.hasher,
        fetch: args.fetch,
        channel: args.channel,
        apiHost: args.apiHost,
        now: args.now
      })

      let postBatch = await classifyForgetHashes({
        hashes: forgetHashes,
        fetch: args.fetch,
        apiHost: args.apiHost
      })
      forgottenHashes = postBatch.forgottenHashes
      outstandingForgetHashes = postBatch.outstandingForgetHashes
      forgetStatuses = postBatch.statuses

      if (outstandingForgetHashes.length > 0) {
        for (const hash of outstandingForgetHashes) {
          const result = await forgetAlephMessages({
            sender: args.sender,
            hashes: [hash],
            reason: args.reason ?? `Prune successful deployments beyond retention limit ${keepCount}`,
            signer: args.signer,
            hasher: args.hasher,
            fetch: args.fetch,
            channel: args.channel,
            apiHost: args.apiHost,
            now: args.now
          })
          followUpForgetResults.push({ hash, result })
        }

        postBatch = await classifyForgetHashes({
          hashes: forgetHashes,
          fetch: args.fetch,
          apiHost: args.apiHost
        })
        forgottenHashes = postBatch.forgottenHashes
        outstandingForgetHashes = postBatch.outstandingForgetHashes
        forgetStatuses = postBatch.statuses
      }
    }
  }

  return {
    sender: args.sender,
    aggregateKey,
    keepCount,
    aggregatePublication,
    retainedRecords,
    prunedRecords,
    forgetHashes,
    forgottenHashes,
    outstandingForgetHashes,
    forgetStatuses,
    forgetResult,
    followUpForgetResults
  }
}
