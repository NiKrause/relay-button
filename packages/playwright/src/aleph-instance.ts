export const SUPPORTED_ALEPH_API_HOSTS = ['https://api2.aleph.im', 'https://api.aleph.im'] as const
export const DEFAULT_ALEPH_SCHEDULER_URL = 'https://scheduler.api.aleph.cloud'

const API3_HOST_PATTERN = /(^|\.)api3\.aleph\.im$/iu

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizeApiOrigin(value: string): string | null {
  try {
    const url = new URL(value)
    if (API3_HOST_PATTERN.test(url.hostname)) return null
    return url.origin
  } catch {
    return null
  }
}

export function resolveAlephApiHosts(candidates?: readonly string[]): string[] {
  const allowed = new Set((candidates ?? SUPPORTED_ALEPH_API_HOSTS).map(normalizeApiOrigin).filter((value): value is string => value != null))
  const selected = SUPPORTED_ALEPH_API_HOSTS.filter((host) => allowed.has(host))
  return selected.length > 0 ? [...selected] : [...SUPPORTED_ALEPH_API_HOSTS]
}

export async function waitForAlephInstanceDeletion(options: {
  instanceHash: string
  apiHosts?: readonly string[]
  schedulerUrl?: string
  timeoutMs?: number
  pollIntervalMs?: number
  fetch?: typeof fetch
}): Promise<string> {
  const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis)
  if (!fetchImpl) throw new Error('A fetch implementation is required for cleanup verification')
  const deadline = Date.now() + (options.timeoutMs ?? 5 * 60_000)
  const hosts = resolveAlephApiHosts(options.apiHosts)
  const schedulerUrl = new URL(`/api/v0/allocation/${options.instanceHash}`, options.schedulerUrl ?? DEFAULT_ALEPH_SCHEDULER_URL)
  let lastSummary = 'Deletion has not been observed yet.'

  while (Date.now() < deadline) {
    const observations: string[] = []
    let replicasForgotten = true
    for (const apiHost of hosts) {
      try {
        const response = await fetchImpl(new URL(`/api/v0/messages/${options.instanceHash}`, apiHost), { cache: 'no-cache' })
        const payload = (await response.json().catch(() => null)) as {
          status?: string
          forgotten_by?: string[]
        } | null
        const forgotten = payload?.status === 'forgotten' || Boolean(payload?.forgotten_by?.length)
        replicasForgotten &&= forgotten
        observations.push(`${apiHost}: ${forgotten ? 'forgotten' : (payload?.status ?? `HTTP ${response.status}`)}`)
      } catch (error) {
        replicasForgotten = false
        observations.push(`${apiHost}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    let unallocated = false
    try {
      const response = await fetchImpl(schedulerUrl, { cache: 'no-cache' })
      const payload = (await response.json().catch(() => null)) as {
        error?: string
      } | null
      unallocated = response.status === 404 || payload?.error === 'VM is not allocated to any node'
      observations.push(`scheduler: ${unallocated ? 'unallocated' : `HTTP ${response.status}`}`)
    } catch (error) {
      observations.push(`scheduler: ${error instanceof Error ? error.message : String(error)}`)
    }

    lastSummary = observations.join('; ')
    if (replicasForgotten && unallocated) return lastSummary
    await delay(options.pollIntervalMs ?? 2_000)
  }
  throw new Error(`Aleph INSTANCE ${options.instanceHash} was not deleted within ${options.timeoutMs ?? 5 * 60_000}ms: ${lastSummary}`)
}
