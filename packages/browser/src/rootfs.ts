import { DEFAULT_ALEPH_API_HOST } from './aleph-api'
import { fetchWithTimeout } from './http'
import type { RootfsManifest, RootfsManifestState, RootfsResolution, MessageStatus } from './types'

export const ITEM_HASH_RE = /^[a-fA-F0-9]{64}$/u

export const DEFAULT_ROOTFS_MANIFEST_URL = './rootfs-manifest.json'
export const DEFAULT_IPFS_GATEWAY_BASE_URL = 'https://ipfs.aleph.cloud/ipfs/'

export interface LoadRootfsManifestOptions {
  baseUrl?: string | URL
}

function resolveManifestUrl(input: string | URL, baseUrl?: string | URL): string | URL {
  if (input instanceof URL) return input

  try {
    return new URL(input, baseUrl ? String(baseUrl) : globalThis.location?.href)
  } catch {
    return input
  }
}

export function validateRootfsManifest(manifest: RootfsManifest | null): RootfsManifestState {
  const errors: string[] = []

  if (!manifest) {
    return { manifest, valid: false, errors: ['Rootfs manifest is missing.'] }
  }

  if (!manifest.version) errors.push('Rootfs manifest version is missing.')
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
  if (manifest.bootstrapSummary != null && !manifest.bootstrapSummary.trim()) {
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
  if (!ITEM_HASH_RE.test(manifest.rootfsItemHash || '')) {
    errors.push('Rootfs ItemHash must be a 64 character hex value.')
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
  if (!manifest.createdAt || Number.isNaN(new Date(manifest.createdAt).getTime())) {
    errors.push('Rootfs creation date is missing or invalid.')
  }

  return { manifest, valid: errors.length === 0, errors }
}

export async function loadRootfsManifest(
  url: string | URL = DEFAULT_ROOTFS_MANIFEST_URL,
  options: LoadRootfsManifestOptions = {}
): Promise<RootfsManifestState> {
  const response = await fetchWithTimeout(resolveManifestUrl(url, options.baseUrl), { cache: 'no-cache' })
  if (!response.ok) {
    throw new Error(`Rootfs manifest request failed: ${response.status}`)
  }

  return validateRootfsManifest((await response.json()) as RootfsManifest)
}

export async function verifyRootfsExists(itemHash: string, apiHost = DEFAULT_ALEPH_API_HOST): Promise<boolean> {
  if (!ITEM_HASH_RE.test(itemHash)) return false

  const response = await fetchWithTimeout(`${apiHost}/api/v0/messages/${itemHash}`, {
    method: 'GET',
    cache: 'no-cache'
  })

  if (response.status === 404) return false
  if (!response.ok) throw new Error(`Rootfs lookup failed: ${response.status}`)

  const payload = await response.json()
  const firstMessage = Array.isArray(payload.messages) ? payload.messages[0] : undefined
  const type = String(payload.type || payload.message?.type || firstMessage?.type || '').toUpperCase()
  return type === 'STORE'
}

function normalizeStatus(status: unknown): MessageStatus {
  if (typeof status !== 'string') return 'unknown'
  const normalized = status.toLowerCase()
  if (normalized === 'processed' || normalized === 'pending' || normalized === 'rejected' || normalized === 'removing' || normalized === 'removed') {
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
  const reason = typeof payload.reason === 'string' ? payload.reason.trim() : ''
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

  if (reason === 'balance_insufficient') {
    return {
      rejectionErrorCode: errorCode,
      rejectionReason: 'The rootfs STORE is being removed because its publisher no longer has enough Aleph credits. Your connected MetaMask balance may be sufficient, but this manifest must point to a newly published, processed rootfs STORE.'
    }
  }

  if (reason) {
    return {
      rejectionErrorCode: errorCode,
      rejectionReason: `Aleph marked the rootfs STORE as unavailable: ${reason.replaceAll('_', ' ')}.`
    }
  }

  return {
    rejectionErrorCode: errorCode,
    rejectionReason: errorCode != null ? `Rejected by Aleph (error code ${errorCode}).` : null
  }
}

async function probeGateway(
  cid: string,
  gatewayBaseUrl = DEFAULT_IPFS_GATEWAY_BASE_URL
): Promise<Pick<RootfsResolution, 'gatewayStatus' | 'gatewayError' | 'gatewayUrl'>> {
  const gatewayUrl = new URL(cid, gatewayBaseUrl).toString()

  try {
    const response = await fetchWithTimeout(gatewayUrl, { method: 'HEAD', cache: 'no-store' }, 5000)
    return {
      gatewayUrl,
      gatewayStatus: response.ok ? 'reachable' : 'error',
      gatewayError: response.ok ? null : `Gateway responded with ${response.status}.`
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('timed out')) {
      return {
        gatewayUrl,
        gatewayStatus: 'timeout',
        gatewayError: error.message
      }
    }

    return {
      gatewayUrl,
      gatewayStatus: 'unavailable',
      gatewayError: error instanceof Error ? error.message : String(error)
    }
  }
}

export async function resolveRootfsReference(
  itemHash: string,
  apiHost = DEFAULT_ALEPH_API_HOST,
  gatewayBaseUrl = DEFAULT_IPFS_GATEWAY_BASE_URL
): Promise<RootfsResolution | null> {
  if (!ITEM_HASH_RE.test(itemHash)) return null

  const response = await fetchWithTimeout(`${apiHost}/api/v0/messages/${itemHash}`, {
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
  const messageStatus = normalizeStatus(payload.status)
  const rejection =
    messageStatus === 'processed' || messageStatus === 'pending'
      ? { rejectionErrorCode: null, rejectionReason: null }
      : parseRejectionReason(payload)
  const gateway = cid
    ? await probeGateway(cid, gatewayBaseUrl)
    : { gatewayUrl: null, gatewayStatus: 'unknown' as const, gatewayError: null }

  return {
    itemHash,
    messageStatus,
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
