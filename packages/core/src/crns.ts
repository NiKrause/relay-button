import type { CrnRecord } from '@le-space/shared-types'

import { DEFAULT_ALEPH_API_HOST, type FetchLike } from './manifests.ts'

export const DEFAULT_CRN_LIST_URL = 'https://crns-list.aleph.sh/crns.json'
export const DEFAULT_COUNTRY_LOOKUP_BASE_URL = 'https://api.country.is'
export const DEFAULT_DNS_RESOLVE_URL = 'https://dns.google/resolve'

// The Aleph core channel aggregate is the on-chain registry every CRN
// registers itself in; crns-list.aleph.sh is only a convenience view on top of
// it that adds live polling. Reading the aggregate keeps the deploy path
// working while that single HTTP service is down.
export const DEFAULT_CRN_AGGREGATE_ADDRESS = '0xa1B3bb7d2332383D96b7796B908fB7f7F3c2Be10'
export const DEFAULT_CRN_AGGREGATE_KEY = 'corechannel'
export const DEFAULT_CRN_AGGREGATE_API_HOSTS: readonly string[] = [
  'https://api2.aleph.im',
  'https://api.aleph.im'
]

export type CrnSource = 'list' | 'aggregate'

type CrnListPayload = {
  crns?: unknown
}

type CoreChannelResourceNode = {
  hash?: unknown
  name?: unknown
  address?: unknown
  score?: unknown
  scoreV1?: unknown
  status?: unknown
  type?: unknown
  inactive_since?: unknown
  parent?: unknown
  locked?: unknown
}

type CoreChannelAggregatePayload = {
  data?: {
    corechannel?: {
      resource_nodes?: unknown
    } | null
  } | null
}

type DnsAnswerPayload = {
  Answer?: Array<{ data?: unknown }>
}

type CountryLookupPayload = {
  ip?: unknown
  city?: unknown
  subdivision?: unknown
  country?: unknown
}

export interface CrnCapacitySpec {
  vcpus: number
  memoryMiB: number
  diskMiB: number
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function normalizeCountryCode(value: unknown): string | null {
  const normalized = asString(value)?.toUpperCase() ?? null
  return normalized && /^[A-Z]{2}$/.test(normalized) ? normalized : null
}

function lookupHost(address: string | undefined): string {
  try {
    return new URL(address ?? '').hostname.trim().toLowerCase()
  } catch {
    return String(address ?? '')
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/:\d+$/, '')
  }
}

function isIpAddress(host: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':')
}

function countryNameFromCode(value: string | null): string | null {
  if (!value) return null
  try {
    const displayNames = new Intl.DisplayNames(['en'], { type: 'region' })
    return displayNames.of(value) ?? value
  } catch {
    return value
  }
}

function compatibleCrns<TCrn extends CrnRecord>(
  crns: ReadonlyArray<TCrn>,
  excludedHashes: ReadonlyArray<string> = []
): TCrn[] {
  const excluded = new Set(excludedHashes.filter(Boolean))

  return [...crns].filter((crn) => {
    if (!crn?.hash || excluded.has(crn.hash)) return false
    if (crn.qemu_support === false) return false
    if (crn.system_usage?.active === false) return false
    return true
  })
}

function hasCrnCapacity(crn: CrnRecord, spec: CrnCapacitySpec | null | undefined): boolean {
  if (!spec) return true

  const usage = crn.system_usage
  if (!usage) return true

  const cpuOk = usage.cpu?.count == null || usage.cpu.count >= spec.vcpus
  const memoryOk = usage.mem?.available_kB == null || usage.mem.available_kB >= spec.memoryMiB * 1024
  const diskOk = usage.disk?.available_kB == null || usage.disk.available_kB >= spec.diskMiB * 1024

  return cpuOk && memoryOk && diskOk
}

function scoreSortedCrns<TCrn extends CrnRecord>(crns: ReadonlyArray<TCrn>): TCrn[] {
  return [...crns].sort((left, right) => {
    const rightScore = typeof right.score === 'number' ? right.score : Number(right.score ?? Number.NEGATIVE_INFINITY)
    const leftScore = typeof left.score === 'number' ? left.score : Number(left.score ?? Number.NEGATIVE_INFINITY)
    if (rightScore !== leftScore) return rightScore - leftScore

    const leftName = (left.name || left.address || left.hash).toLowerCase()
    const rightName = (right.name || right.address || right.hash).toLowerCase()
    return leftName.localeCompare(rightName)
  })
}

// The network score measures generic node health, not our workload path: a
// CRN can rank ~0.99 and still consistently fail the allocation-notify /
// setup-endpoint flow. Always starting at rank 1 makes every deploy pay for
// such a node first (observed: 12 minutes per attempt, every run). Shuffling
// the top pool spreads first-pick across several near-equally-scored nodes
// while failover still walks the full ordered tail. Applied only on the
// no-country-preference path: an explicit preference requests deterministic
// geo-first ordering.
const TOP_CRN_POOL_SIZE = 5

function shuffleTopPool<TCrn>(sorted: TCrn[], poolSize: number = TOP_CRN_POOL_SIZE): TCrn[] {
  const pool = sorted.slice(0, poolSize)
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  return [...pool, ...sorted.slice(poolSize)]
}

export function filterDeployableCrns<TCrn extends CrnRecord>(
  crns: ReadonlyArray<TCrn>,
  options: {
    excludedHashes?: ReadonlyArray<string>
    spec?: CrnCapacitySpec | null
  } = {}
): TCrn[] {
  return scoreSortedCrns(
    compatibleCrns(crns, options.excludedHashes).filter((crn) => hasCrnCapacity(crn, options.spec))
  )
}

async function resolveHostIp(
  host: string,
  options: {
    fetch: FetchLike
    dnsResolveUrl?: string
  }
): Promise<string | null> {
  if (!host) return null
  if (isIpAddress(host)) return host

  for (const type of ['A', 'AAAA']) {
    const url = new URL(options.dnsResolveUrl ?? DEFAULT_DNS_RESOLVE_URL)
    url.searchParams.set('name', host)
    url.searchParams.set('type', type)
    url.searchParams.set('edns_client_subnet', '0.0.0.0/0')

    const response = await options.fetch(url.toString(), {
      cache: 'no-cache'
    })
    if (!response.ok) continue

    const payload = (await response.json()) as DnsAnswerPayload
    const record = Array.isArray(payload?.Answer)
      ? payload.Answer.find((entry) => typeof entry?.data === 'string' && entry.data.trim())
      : null

    if (typeof record?.data === 'string' && record.data.trim()) {
      return record.data.trim()
    }
  }

  return null
}

async function lookupIpLocation(
  ip: string,
  options: {
    fetch: FetchLike
    countryLookupBaseUrl?: string
  }
): Promise<Pick<CrnRecord, 'resolved_ip' | 'city' | 'region' | 'country' | 'country_code' | 'geo_source'>> {
  const url = new URL(`${options.countryLookupBaseUrl ?? DEFAULT_COUNTRY_LOOKUP_BASE_URL}/${encodeURIComponent(ip)}`)
  url.searchParams.set('fields', 'city,subdivision')

  const response = await options.fetch(url.toString(), {
    cache: 'no-cache'
  })

  if (!response.ok) {
    return {
      resolved_ip: ip,
      city: null,
      region: null,
      country: null,
      country_code: null,
      geo_source: null
    }
  }

  const payload = (await response.json()) as CountryLookupPayload
  const countryCode = normalizeCountryCode(payload?.country)
  return {
    resolved_ip: asString(payload?.ip) ?? ip,
    city: asString(payload?.city),
    region: asString(payload?.subdivision),
    country: countryNameFromCode(countryCode),
    country_code: countryCode,
    geo_source: 'country.is'
  }
}

export async function fetchCrnsFromList(
  options: {
    url?: string
    fetch: FetchLike
  }
): Promise<CrnRecord[]> {
  const requestUrl = new URL(options.url ?? DEFAULT_CRN_LIST_URL)
  requestUrl.searchParams.set('filter_inactive', 'true')
  const response = await options.fetch(requestUrl.toString(), {
    cache: 'no-cache'
  })

  if (!response.ok) {
    throw new Error(`CRN list request failed: ${response.status}`)
  }

  const payload = (await response.json()) as CrnListPayload
  return Array.isArray(payload?.crns) ? (payload.crns as CrnRecord[]) : []
}

function normalizeCrnAddress(value: unknown): string | null {
  const address = asString(value)
  if (!address) return null

  const withScheme = /^https?:\/\//i.test(address) ? address : `https://${address}`
  try {
    return new URL(withScheme).toString().replace(/\/+$/, '')
  } catch {
    return null
  }
}

function aggregateScore(node: CoreChannelResourceNode): number | null {
  for (const candidate of [node.score, node.scoreV1]) {
    if (candidate == null || candidate === '') continue
    const numeric = typeof candidate === 'number' ? candidate : Number(candidate)
    if (Number.isFinite(numeric)) return numeric
  }
  return null
}

// The aggregate lists every registered node, including ones that never linked
// to a core channel node or that the registry already marked inactive. Those
// can never take an allocation, so they are dropped before ranking.
function isDeployableResourceNode(node: CoreChannelResourceNode): boolean {
  if (!asString(node.hash)) return false
  if (!normalizeCrnAddress(node.address)) return false
  if (node.inactive_since != null) return false
  if (node.locked === true) return false

  const type = asString(node.type)?.toLowerCase()
  if (type && type !== 'compute') return false

  const status = asString(node.status)?.toLowerCase()
  if (status && status !== 'linked' && status !== 'active') return false

  return Boolean(asString(node.parent))
}

export function mapResourceNodesToCrns(resourceNodes: unknown): CrnRecord[] {
  if (!Array.isArray(resourceNodes)) return []

  return resourceNodes
    .filter((node): node is CoreChannelResourceNode => Boolean(node) && typeof node === 'object')
    .filter(isDeployableResourceNode)
    .map((node) => {
      const record: CrnRecord = {
        hash: asString(node.hash) as string,
        address: normalizeCrnAddress(node.address) as string
      }

      const name = asString(node.name)
      if (name) record.name = name

      const score = aggregateScore(node)
      if (score != null) record.score = score

      // qemu_support and system_usage only exist in the polled list. Leaving
      // them undefined keeps filterDeployableCrns permissive instead of
      // dropping every node for a signal the aggregate cannot carry.
      return record
    })
}

export async function fetchCrnsFromAggregate(options: {
  fetch: FetchLike
  apiHosts?: readonly string[]
  address?: string
  aggregateKey?: string
}): Promise<CrnRecord[]> {
  const apiHosts = options.apiHosts?.length ? options.apiHosts : DEFAULT_CRN_AGGREGATE_API_HOSTS
  const address = options.address ?? DEFAULT_CRN_AGGREGATE_ADDRESS
  const aggregateKey = options.aggregateKey ?? DEFAULT_CRN_AGGREGATE_KEY
  let lastError: unknown = null

  for (const apiHost of apiHosts) {
    try {
      const url = new URL(`/api/v0/aggregates/${address}.json`, apiHost)
      url.searchParams.set('keys', aggregateKey)

      const response = await options.fetch(url.toString(), { cache: 'no-cache' })
      if (!response.ok) {
        lastError = new Error(`CRN aggregate request failed: ${response.status}`)
        continue
      }

      const payload = (await response.json()) as CoreChannelAggregatePayload
      const crns = mapResourceNodesToCrns(payload?.data?.corechannel?.resource_nodes)
      if (crns.length > 0) return crns

      lastError = new Error('CRN aggregate contained no deployable resource nodes')
    } catch (error) {
      lastError = error
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'CRN aggregate request failed'))
}

export interface CrnSourceOptions {
  fetch: FetchLike
  url?: string
  aggregateApiHosts?: readonly string[]
  aggregateAddress?: string
  /** Skip crns.json entirely and read the core channel aggregate directly. */
  preferAggregate?: boolean
  onDiagnostic?: (message: string) => void
}

export interface CrnSourceResult {
  crns: CrnRecord[]
  source: CrnSource
  listError?: Error
}

/**
 * Reads the CRN candidate set, preferring the polled crns.json list because it
 * carries live status, capacity and qemu support, and falling back to the core
 * channel aggregate whenever that single HTTP service is unavailable.
 */
export async function fetchCrnsWithSource(options: CrnSourceOptions): Promise<CrnSourceResult> {
  const aggregateOptions = {
    fetch: options.fetch,
    apiHosts: options.aggregateApiHosts,
    address: options.aggregateAddress
  }

  if (options.preferAggregate) {
    return { crns: await fetchCrnsFromAggregate(aggregateOptions), source: 'aggregate' }
  }

  let listError: Error
  try {
    const crns = await fetchCrnsFromList({ url: options.url, fetch: options.fetch })
    if (crns.length > 0) return { crns, source: 'list' }
    listError = new Error('CRN list returned no entries')
  } catch (error) {
    listError = error instanceof Error ? error : new Error(String(error))
  }

  options.onDiagnostic?.(`CRN list unavailable (${listError.message}); falling back to the ${DEFAULT_CRN_AGGREGATE_KEY} aggregate`)

  try {
    return { crns: await fetchCrnsFromAggregate(aggregateOptions), source: 'aggregate', listError }
  } catch (aggregateError) {
    const message = aggregateError instanceof Error ? aggregateError.message : String(aggregateError)
    throw new Error(`${listError.message}; CRN aggregate fallback failed: ${message}`)
  }
}

export async function fetchCrns(options: CrnSourceOptions): Promise<CrnRecord[]> {
  return (await fetchCrnsWithSource(options)).crns
}

export async function enrichCrnsWithGeo(
  crns: ReadonlyArray<CrnRecord>,
  options: {
    fetch: FetchLike
    dnsResolveUrl?: string
    countryLookupBaseUrl?: string
  }
): Promise<CrnRecord[]> {
  return Promise.all(
    crns.map(async (crn) => {
      if (crn.city || crn.region || crn.country || crn.country_code) {
        return crn
      }

      try {
        const host = lookupHost(crn.address)
        const ip = await resolveHostIp(host, {
          fetch: options.fetch,
          dnsResolveUrl: options.dnsResolveUrl
        })
        if (!ip) return crn

        return {
          ...crn,
          ...(await lookupIpLocation(ip, {
            fetch: options.fetch,
            countryLookupBaseUrl: options.countryLookupBaseUrl
          }))
        }
      } catch {
        return crn
      }
    })
  )
}

export async function listGeocodedCrns(options: {
  fetch: FetchLike
  url?: string
  limit?: number
  dnsResolveUrl?: string
  countryLookupBaseUrl?: string
}): Promise<CrnRecord[]> {
  const sortedCrns = filterDeployableCrns(await fetchCrns({
    url: options.url,
    fetch: options.fetch
  }))

  const geocodedCrns = await enrichCrnsWithGeo(
    sortedCrns.slice(0, Math.max(1, Number(options.limit) || 30)),
    options
  )

  return geocodedCrns
    .filter((crn) => Boolean(crn.city || crn.region || crn.country || crn.country_code))
    .sort((left, right) => {
      const leftLabel = `${left.country ?? ''}/${left.region ?? ''}/${left.city ?? ''}/${left.name ?? left.hash}`.toLowerCase()
      const rightLabel = `${right.country ?? ''}/${right.region ?? ''}/${right.city ?? ''}/${right.name ?? right.hash}`.toLowerCase()
      return leftLabel.localeCompare(rightLabel)
    })
}

export async function rankCandidateCrns(
  crns: ReadonlyArray<CrnRecord>,
  options: {
    fetch: FetchLike
    preferredCountryCode?: string
    geoLimit?: number
    excludedHashes?: string[]
    dnsResolveUrl?: string
    countryLookupBaseUrl?: string
  }
): Promise<CrnRecord[]> {
  const preferredCountryCode = normalizeCountryCode(options.preferredCountryCode)
  const geoLimit = Math.max(1, Number(options.geoLimit) || 30)
  const sortedCrns = filterDeployableCrns(crns, {
    excludedHashes: options.excludedHashes
  })
  if (!preferredCountryCode || sortedCrns.length === 0) {
    return shuffleTopPool(sortedCrns)
  }

  const enrichedTopCrns = await enrichCrnsWithGeo(sortedCrns.slice(0, geoLimit), options)
  const mergedByHash = new Map(enrichedTopCrns.map((crn) => [crn.hash, crn]))
  const mergedCrns = sortedCrns.map((crn) => mergedByHash.get(crn.hash) ?? crn)
  const originalIndex = new Map(mergedCrns.map((crn, index) => [crn.hash, index]))

  return [...mergedCrns].sort((left, right) => {
    const leftPreferred = normalizeCountryCode(left.country_code) === preferredCountryCode ? 1 : 0
    const rightPreferred = normalizeCountryCode(right.country_code) === preferredCountryCode ? 1 : 0
    if (leftPreferred !== rightPreferred) {
      return rightPreferred - leftPreferred
    }

    return (originalIndex.get(left.hash) ?? Number.MAX_SAFE_INTEGER) - (originalIndex.get(right.hash) ?? Number.MAX_SAFE_INTEGER)
  })
}

// crns.json filters inactive nodes for us; the aggregate has no such signal,
// so reachability has to be established by asking the node itself. The
// executions listing is the same endpoint the deploy loop polls afterwards,
// which makes it a direct check of the path we actually need.
const CRN_PROBE_PATHS = ['/v2/about/executions/list', '/about/executions/list'] as const

export async function probeCrnAvailability(
  crn: CrnRecord,
  options: {
    fetch: FetchLike
  }
): Promise<boolean> {
  const address = crn.address ? String(crn.address).replace(/\/+$/, '') : ''
  if (!address) return false

  for (const path of CRN_PROBE_PATHS) {
    try {
      const response = await options.fetch(`${address}${path}`, { cache: 'no-cache' })
      if (response.ok) return true
      // A non-404 answer still proves the node is serving requests; only a
      // missing route justifies trying the older endpoint.
      if (response.status !== 404) return response.status < 500
    } catch {
      return false
    }
  }

  return false
}

/**
 * Drops candidates that do not answer their executions endpoint, preserving
 * the incoming ranking. Only the head of the list is probed: failover walks the
 * ordered tail anyway, and probing every registered node would cost more than
 * it saves. Returns the input unchanged when nothing answers, so a runner that
 * cannot reach CRNs directly still gets to attempt a deploy.
 */
export async function filterReachableCrns<TCrn extends CrnRecord>(
  crns: ReadonlyArray<TCrn>,
  options: {
    fetch: FetchLike
    limit?: number
    onDiagnostic?: (message: string) => void
  }
): Promise<TCrn[]> {
  const limit = Math.max(1, Number(options.limit) || 10)
  const probed = crns.slice(0, limit)
  if (probed.length === 0) return [...crns]

  const reachable = await Promise.all(
    probed.map(async (crn) => ({ crn, ok: await probeCrnAvailability(crn, { fetch: options.fetch }) }))
  )

  const live = reachable.filter((entry) => entry.ok).map((entry) => entry.crn)
  if (live.length === 0) {
    options.onDiagnostic?.(`No CRN answered its executions endpoint (${probed.length} probed); keeping the unverified ranking`)
    return [...crns]
  }

  const skipped = probed.length - live.length
  if (skipped > 0) {
    options.onDiagnostic?.(`Skipping ${skipped} unreachable CRN${skipped === 1 ? '' : 's'} of ${probed.length} probed`)
  }

  return [...live, ...crns.slice(limit)]
}

export async function selectPreferredCrn(
  crns: ReadonlyArray<CrnRecord>,
  options: {
    fetch: FetchLike
    preferredCountryCode?: string
    geoLimit?: number
    excludedHashes?: string[]
    dnsResolveUrl?: string
    countryLookupBaseUrl?: string
  }
): Promise<CrnRecord | null> {
  return (await rankCandidateCrns(crns, options))[0] ?? null
}
