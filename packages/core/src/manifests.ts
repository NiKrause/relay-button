import type { RootfsManifest, RootfsManifestState, RootfsResolution, MessageStatus } from '@shared-aleph/shared-types'

export const ITEM_HASH_RE = /^[a-fA-F0-9]{64}$/
export const DEFAULT_ALEPH_API_HOST = 'https://api2.aleph.im'
export const DEFAULT_IPFS_GATEWAY_BASE_URL = 'https://ipfs.aleph.cloud/ipfs/'

export interface FetchLikeResponse {
  ok: boolean
  status: number
  url?: string
  json(): Promise<unknown>
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<FetchLikeResponse>

function isValidDateString(value: string): boolean {
  return value.trim().length > 0 && !Number.isNaN(new Date(value).getTime())
}

export function validateRootfsManifest(manifest: RootfsManifest | null): RootfsManifestState {
  const errors: string[] = []

  if (!manifest) {
    return { manifest, valid: false, errors: ['Rootfs manifest is missing.'] }
  }

  if (!manifest.version || !manifest.version.trim()) {
    errors.push('Rootfs manifest version is missing.')
  }

  if (
    manifest.rootfsInstallStrategy != null &&
    manifest.rootfsInstallStrategy !== 'thin' &&
    manifest.rootfsInstallStrategy !== 'prebaked'
  ) {
    errors.push('Rootfs install strategy must be "thin" or "prebaked" when provided.')
  }

  if (
    manifest.requiresBootstrapNetwork != null &&
    typeof manifest.requiresBootstrapNetwork !== 'boolean'
  ) {
    errors.push('Rootfs bootstrap network flag must be a boolean when provided.')
  }

  if (
    manifest.bootstrapSummary != null &&
    (typeof manifest.bootstrapSummary !== 'string' || !manifest.bootstrapSummary.trim())
  ) {
    errors.push('Rootfs bootstrap summary must be non-empty when provided.')
  }

  if (manifest.requiredPortForwards != null) {
    if (!Array.isArray(manifest.requiredPortForwards)) {
      errors.push('Rootfs required port forwards must be an array when provided.')
    } else {
      manifest.requiredPortForwards.forEach((entry, index) => {
        if (!entry || typeof entry !== 'object') {
          errors.push(`Rootfs required port forward #${index + 1} must be an object.`)
          return
        }

        if (!Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535) {
          errors.push(`Rootfs required port forward #${index + 1} must use a TCP/UDP port between 1 and 65535.`)
        }

        if (entry.tcp !== true && entry.udp !== true) {
          errors.push(`Rootfs required port forward #${index + 1} must enable TCP or UDP.`)
        }

        if (entry.purpose != null && (typeof entry.purpose !== 'string' || !entry.purpose.trim())) {
          errors.push(`Rootfs required port forward #${index + 1} purpose must be non-empty when provided.`)
        }
      })
    }
  }

  if (manifest.rootfsItemHash != null && !ITEM_HASH_RE.test(manifest.rootfsItemHash)) {
    errors.push('Rootfs ItemHash must be a 64 character hex value when provided.')
  }

  if (manifest.rootfsCid != null && (typeof manifest.rootfsCid !== 'string' || !manifest.rootfsCid.trim())) {
    errors.push('Rootfs CID must be a non-empty string when provided.')
  }

  if (!Number.isInteger(manifest.rootfsSizeMiB) || manifest.rootfsSizeMiB <= 0) {
    errors.push('Rootfs size must be a positive MiB integer.')
  }

  if (
    manifest.rootfsSourceSizeBytes != null &&
    (!Number.isInteger(manifest.rootfsSourceSizeBytes) || manifest.rootfsSourceSizeBytes <= 0)
  ) {
    errors.push('Rootfs source size must be a positive byte integer when provided.')
  }

  if (!isValidDateString(manifest.createdAt)) {
    errors.push('Rootfs creation date is missing or invalid.')
  }

  return { manifest, valid: errors.length === 0, errors }
}

function normalizeStatus(status: unknown): MessageStatus {
  if (typeof status !== 'string') return 'unknown'
  const normalized = status.toLowerCase()
  if (normalized === 'processed' || normalized === 'pending' || normalized === 'rejected') {
    return normalized
  }
  return 'unknown'
}

function parseCidFromPayload(payload: Record<string, unknown>): string | null {
  const firstMessage =
    Array.isArray(payload.messages) && payload.messages[0] && typeof payload.messages[0] === 'object'
      ? (payload.messages[0] as Record<string, unknown>)
      : null

  const directContent =
    firstMessage?.content && typeof firstMessage.content === 'object'
      ? (firstMessage.content as Record<string, unknown>)
      : null

  if (typeof directContent?.item_hash === 'string') {
    return directContent.item_hash
  }

  if (typeof firstMessage?.item_content === 'string') {
    try {
      const itemContent = JSON.parse(firstMessage.item_content) as Record<string, unknown>
      if (typeof itemContent.item_hash === 'string') {
        return itemContent.item_hash
      }
    } catch {
      return null
    }
  }

  return null
}

function parseRejectionReason(payload: Record<string, unknown>): Pick<RootfsResolution, 'rejectionErrorCode' | 'rejectionReason'> {
  const errorCode = typeof payload.error_code === 'number' ? payload.error_code : null
  const details = payload.details && typeof payload.details === 'object' ? (payload.details as Record<string, unknown>) : null
  const rawErrors = Array.isArray(details?.errors) ? details.errors : []
  const firstError =
    rawErrors[0] && typeof rawErrors[0] === 'object' ? (rawErrors[0] as Record<string, unknown>) : null

  if (firstError) {
    const accountBalance = Number(firstError.account_balance)
    const requiredBalance = Number(firstError.required_balance)
    if (Number.isFinite(accountBalance) && Number.isFinite(requiredBalance)) {
      const shortfall = requiredBalance - accountBalance
      return {
        rejectionErrorCode: errorCode,
        rejectionReason:
          shortfall > 0
            ? `Rejected by Aleph for insufficient hold balance: ${accountBalance.toFixed(3)} available, ${requiredBalance.toFixed(3)} required, ${shortfall.toFixed(3)} short.`
            : `Rejected by Aleph for insufficient hold balance: ${accountBalance.toFixed(3)} available, ${requiredBalance.toFixed(3)} required.`
      }
    }
  }

  return {
    rejectionErrorCode: errorCode,
    rejectionReason: errorCode != null ? `Rejected by Aleph (error code ${errorCode}).` : null
  }
}

export async function verifyRootfsExists(
  itemHash: string,
  options: {
    apiHost?: string
    fetch: FetchLike
  }
): Promise<boolean> {
  if (!ITEM_HASH_RE.test(itemHash)) return false

  const apiHost = options.apiHost ?? DEFAULT_ALEPH_API_HOST
  const response = await options.fetch(`${apiHost}/api/v0/messages/${itemHash}`, {
    method: 'GET',
    cache: 'no-cache'
  })

  if (response.status === 404) return false
  if (!response.ok) throw new Error(`Rootfs lookup failed: ${response.status}`)

  const payload = (await response.json()) as Record<string, unknown>
  const firstMessage = Array.isArray(payload.messages) ? payload.messages[0] as Record<string, unknown> | undefined : undefined
  const type = String(payload.type || (payload.message as Record<string, unknown> | undefined)?.type || firstMessage?.type || '').toUpperCase()
  return type === 'STORE'
}

export async function probeRootfsGateway(
  cid: string,
  options: {
    gatewayBaseUrl?: string
    fetch: FetchLike
  }
): Promise<Pick<RootfsResolution, 'gatewayStatus' | 'gatewayError' | 'gatewayUrl'>> {
  const gatewayUrl = new URL(cid, options.gatewayBaseUrl ?? DEFAULT_IPFS_GATEWAY_BASE_URL).toString()

  try {
    const response = await options.fetch(gatewayUrl, { method: 'HEAD', cache: 'no-store' })
    return {
      gatewayUrl,
      gatewayStatus: response.ok ? 'reachable' : 'error',
      gatewayError: response.ok ? null : `Gateway responded with ${response.status}.`
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      gatewayUrl,
      gatewayStatus: message.includes('timed out') ? 'timeout' : 'unavailable',
      gatewayError: message
    }
  }
}

export async function resolveRootfsReference(
  itemHash: string,
  options: {
    apiHost?: string
    gatewayBaseUrl?: string
    fetch: FetchLike
  }
): Promise<RootfsResolution | null> {
  if (!ITEM_HASH_RE.test(itemHash)) return null

  const apiHost = options.apiHost ?? DEFAULT_ALEPH_API_HOST
  const response = await options.fetch(`${apiHost}/api/v0/messages/${itemHash}`, {
    method: 'GET',
    cache: 'no-cache'
  })

  if (response.status === 404) return null
  if (!response.ok) throw new Error(`Rootfs lookup failed: ${response.status}`)

  const payload = (await response.json()) as Record<string, unknown>
  const firstMessage =
    Array.isArray(payload.messages) && payload.messages[0] && typeof payload.messages[0] === 'object'
      ? (payload.messages[0] as Record<string, unknown>)
      : null
  const messageObject =
    payload.message && typeof payload.message === 'object' ? (payload.message as Record<string, unknown>) : null

  const cid = parseCidFromPayload(payload)
  const rejection =
    normalizeStatus(payload.status) === 'rejected'
      ? parseRejectionReason(payload)
      : { rejectionErrorCode: null, rejectionReason: null }
  const gateway = cid
    ? await probeRootfsGateway(cid, {
        gatewayBaseUrl: options.gatewayBaseUrl,
        fetch: options.fetch
      })
    : { gatewayUrl: null, gatewayStatus: 'unknown' as const, gatewayError: null }

  return {
    itemHash,
    messageStatus: normalizeStatus(payload.status),
    messageType: String(payload.type || messageObject?.type || firstMessage?.type || '').toUpperCase() || null,
    cid,
    receptionTime: typeof payload.reception_time === 'string' ? payload.reception_time : null,
    rejectionErrorCode: rejection.rejectionErrorCode,
    rejectionReason: rejection.rejectionReason,
    gatewayUrl: gateway.gatewayUrl,
    gatewayStatus: gateway.gatewayStatus,
    gatewayError: gateway.gatewayError
  }
}
