import type { CrnRecord } from '@le-space/shared-types'

import { DEFAULT_ALEPH_API_HOST, type FetchLike } from './manifests.ts'

export const DEFAULT_CRN_LIST_URL = 'https://crns-list.aleph.sh/crns.json'
export const DEFAULT_COUNTRY_LOOKUP_BASE_URL = 'https://api.country.is'
export const DEFAULT_DNS_RESOLVE_URL = 'https://dns.google/resolve'

type CrnListPayload = {
  crns?: unknown
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

export async function fetchCrns(
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
    return sortedCrns
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
