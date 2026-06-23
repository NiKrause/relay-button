import {
  broadcastAlephMessage,
  broadcastInstanceMessage,
  configureOrbitdbRelaySetup,
  DEFAULT_ALEPH_API_HOST,
  DEFAULT_ALEPH_API_HOSTS,
  DEFAULT_2N6_API_HOST,
  DEFAULT_CRN_LIST_URL,
  DEFAULT_ALEPH_SCHEDULER_API_HOST,
  fetchBalance,
  fetch2n6WebAccessUrl,
  fetchCrnExecutionMap,
  fetchCrns,
  fetchInstances,
  fetchMessageEnvelope,
  fetchSchedulerAllocation,
  notifyCrnAllocation,
  inspectDeploymentResult,
  waitForDeploymentResult
} from './aleph-api'
import type { AlephBrowserClient } from './types'

type ApiHostInput = string | readonly string[]

export interface CreateAlephBrowserClientOptions {
  apiHost?: string
  apiHosts?: ApiHostInput
  crnListUrl?: string
  schedulerApiHost?: string
  twoN6ApiHost?: string
}

function normalizeApiHost(value: string): string | null {
  const trimmed = value.trim().replace(/\/+$/u, '')
  return trimmed ? trimmed : null
}

function normalizeApiHosts(input: ApiHostInput | undefined, fallbackApiHost: string): string[] {
  const rawValues = Array.isArray(input) ? input : typeof input === 'string' ? input.split(/[\s,]+/u) : []
  const hosts = rawValues
    .map((value) => normalizeApiHost(String(value)))
    .filter((value): value is string => Boolean(value))

  if (hosts.length > 0) return Array.from(new Set(hosts))

  const fallback = normalizeApiHost(fallbackApiHost)
  return fallback ? [fallback] : [...DEFAULT_ALEPH_API_HOSTS]
}

async function withApiHostFallback<T>(apiHosts: readonly string[], run: (apiHost: string) => Promise<T>): Promise<T> {
  let lastError: unknown = null

  for (let index = 0; index < apiHosts.length; index += 1) {
    const apiHost = apiHosts[index]
    try {
      return await run(apiHost)
    } catch (error) {
      lastError = error
      if (index >= apiHosts.length - 1) break
    }
  }

  if (lastError instanceof Error) throw lastError
  throw new Error(String(lastError))
}

export function createAlephBrowserClient(options: CreateAlephBrowserClientOptions = {}): AlephBrowserClient {
  const apiHosts = options.apiHosts === undefined && options.apiHost === undefined
    ? [...DEFAULT_ALEPH_API_HOSTS]
    : normalizeApiHosts(options.apiHosts, options.apiHost ?? DEFAULT_ALEPH_API_HOST)
  const apiHost = apiHosts[0] ?? DEFAULT_ALEPH_API_HOST
  const crnListUrl = options.crnListUrl ?? DEFAULT_CRN_LIST_URL
  const schedulerApiHost = options.schedulerApiHost ?? DEFAULT_ALEPH_SCHEDULER_API_HOST
  const twoN6ApiHost = options.twoN6ApiHost ?? DEFAULT_2N6_API_HOST

  return {
    apiHost,
    apiHosts,
    crnListUrl,
    schedulerApiHost,
    fetchBalance(address) {
      return withApiHostFallback(apiHosts, (host) => fetchBalance(address, host))
    },
    fetchCrns() {
      return fetchCrns(crnListUrl)
    },
    fetchInstances(address) {
      return withApiHostFallback(apiHosts, (host) => fetchInstances(address, host))
    },
    fetch2n6WebAccessUrl(itemHash) {
      return fetch2n6WebAccessUrl(itemHash, twoN6ApiHost)
    },
    fetchMessageEnvelope(itemHash) {
      return withApiHostFallback(apiHosts, (host) => fetchMessageEnvelope(itemHash, host))
    },
    fetchSchedulerAllocation(itemHash) {
      return fetchSchedulerAllocation(itemHash, schedulerApiHost)
    },
    fetchCrnExecutionMap(crnUrl) {
      return fetchCrnExecutionMap(crnUrl)
    },
    notifyCrnAllocation(crnUrl, itemHash) {
      return notifyCrnAllocation(crnUrl, itemHash)
    },
    configureOrbitdbRelaySetup(args) {
      return configureOrbitdbRelaySetup(args)
    },
    inspectDeploymentResult(itemHash, rootfsRef) {
      return withApiHostFallback(apiHosts, (host) => inspectDeploymentResult(itemHash, rootfsRef, host))
    },
    waitForDeploymentResult(itemHash, rootfsRef, attempts, delayMs) {
      return withApiHostFallback(apiHosts, (host) => waitForDeploymentResult(itemHash, rootfsRef, host, attempts, delayMs))
    },
    broadcastInstanceMessage(message, sync) {
      return withApiHostFallback(apiHosts, (host) => broadcastInstanceMessage(message, host, sync))
    },
    broadcastAlephMessage(message, sync) {
      return withApiHostFallback(apiHosts, (host) => broadcastAlephMessage(message, host, sync))
    }
  }
}
