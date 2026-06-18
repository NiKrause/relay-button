export interface UcanStoreBootstrapPackage {
  operatorAddress: string
  adminDid: string
  serviceDid?: string | null
  spaceDid: string
  rootDelegationProof: string
  allowedCapabilities: string[]
  defaultUserDelegationExpiration?: number | null
  maxUserDelegationExpiration?: number | null
  pwaOrigin: string
  serviceOrigin: string
}

export interface UcanStoreBootstrapValidationResult {
  valid: boolean
  errors: string[]
  bootstrapPackage: UcanStoreBootstrapPackage | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized ? normalized : null
}

function normalizeDid(value: unknown): string | null {
  const did = normalizeNonEmptyString(value)
  return did && did.startsWith('did:') ? did : null
}

function normalizeOrigin(value: unknown): string | null {
  const raw = normalizeNonEmptyString(value)
  if (!raw) return null

  try {
    const parsed = new URL(raw)
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      !parsed.hostname ||
      (parsed.pathname && parsed.pathname !== '/') ||
      parsed.search ||
      parsed.hash
    ) {
      return null
    }
    return parsed.origin
  } catch {
    return null
  }
}

function normalizeExpiration(value: unknown): number | null | undefined {
  if (value == null) return undefined
  if (value === null) return null
  if (!Number.isInteger(value) || Number(value) < 0) return undefined
  return Number(value)
}

export function validateUcanStoreBootstrapPackage(
  value: unknown,
): UcanStoreBootstrapValidationResult {
  if (!isRecord(value)) {
    return {
      valid: false,
      errors: ['Bootstrap package must be a JSON object.'],
      bootstrapPackage: null,
    }
  }

  const errors: string[] = []
  const operatorAddress = normalizeNonEmptyString(value.operatorAddress)
  if (!operatorAddress || !/^0x[a-fA-F0-9]{40}$/.test(operatorAddress)) {
    errors.push('operatorAddress must be a 0x-prefixed 20-byte Ethereum address.')
  }

  const adminDid = normalizeDid(value.adminDid)
  if (!adminDid) {
    errors.push('adminDid must be a non-empty DID string.')
  }

  const serviceDidRaw = value.serviceDid
  const serviceDid =
    serviceDidRaw == null || serviceDidRaw === ''
      ? null
      : normalizeDid(serviceDidRaw)
  if (serviceDidRaw != null && serviceDidRaw !== '' && !serviceDid) {
    errors.push('serviceDid must be empty or a non-empty DID string.')
  }

  const spaceDid = normalizeDid(value.spaceDid)
  if (!spaceDid) {
    errors.push('spaceDid must be a non-empty DID string.')
  }

  const rootDelegationProof = normalizeNonEmptyString(value.rootDelegationProof)
  if (!rootDelegationProof) {
    errors.push('rootDelegationProof must be a non-empty proof string.')
  }

  const allowedCapabilities = Array.isArray(value.allowedCapabilities)
    ? value.allowedCapabilities
        .map((entry) => normalizeNonEmptyString(entry))
        .filter((entry): entry is string => Boolean(entry))
    : []
  if (allowedCapabilities.length === 0) {
    errors.push('allowedCapabilities must contain at least one capability string.')
  }

  const defaultUserDelegationExpiration = normalizeExpiration(
    value.defaultUserDelegationExpiration,
  )
  if (
    value.defaultUserDelegationExpiration != null &&
    defaultUserDelegationExpiration === undefined
  ) {
    errors.push(
      'defaultUserDelegationExpiration must be null or a non-negative integer number of seconds.',
    )
  }

  const maxUserDelegationExpiration = normalizeExpiration(
    value.maxUserDelegationExpiration,
  )
  if (
    value.maxUserDelegationExpiration != null &&
    maxUserDelegationExpiration === undefined
  ) {
    errors.push(
      'maxUserDelegationExpiration must be null or a non-negative integer number of seconds.',
    )
  }
  if (
    typeof defaultUserDelegationExpiration === 'number' &&
    typeof maxUserDelegationExpiration === 'number' &&
    defaultUserDelegationExpiration > maxUserDelegationExpiration
  ) {
    errors.push(
      'defaultUserDelegationExpiration cannot exceed maxUserDelegationExpiration.',
    )
  }

  const pwaOrigin = normalizeOrigin(value.pwaOrigin)
  if (!pwaOrigin) {
    errors.push('pwaOrigin must be an http(s) origin without path, query, or hash.')
  }

  const serviceOrigin = normalizeOrigin(value.serviceOrigin)
  if (!serviceOrigin) {
    errors.push('serviceOrigin must be an http(s) origin without path, query, or hash.')
  }

  if (errors.length > 0) {
    return {
      valid: false,
      errors,
      bootstrapPackage: null,
    }
  }

  return {
    valid: true,
    errors: [],
    bootstrapPackage: {
      operatorAddress: operatorAddress!,
      adminDid: adminDid!,
      serviceDid,
      spaceDid: spaceDid!,
      rootDelegationProof: rootDelegationProof!,
      allowedCapabilities,
      defaultUserDelegationExpiration,
      maxUserDelegationExpiration,
      pwaOrigin: pwaOrigin!,
      serviceOrigin: serviceOrigin!,
    },
  }
}
