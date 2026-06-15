import type { MessageSigner } from '@le-space/shared-types'

import { DEFAULT_CRN_LIST_URL, fetchCrns } from './crns.ts'
import { fetchMessageEnvelope } from './deployment-inspection.ts'
import { DEFAULT_ALEPH_API_HOST, type FetchLike } from './manifests.ts'
import { DEFAULT_SCHEDULER_ALLOCATION_URL, fetchSchedulerAllocation } from './runtime.ts'

export interface CrnResolutionResult {
  crnUrl: string | null
  crnHash: string | null
  source: 'provided' | 'scheduler' | 'manual' | 'missing'
}

export interface CrnEraseResult extends CrnResolutionResult {
  status: 'erased' | 'missing' | 'skipped'
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function utf8Hex(value: string): string {
  return bytesToHex(new TextEncoder().encode(value))
}

function normalizeHexSignature(signature: string): string {
  return signature.startsWith('0x') ? signature : `0x${signature}`
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/u, '')
}

function isoTimestampWithMicros(date = new Date()): string {
  return date.toISOString().replace(/\.(\d{3})Z$/u, '.$1000Z')
}

async function generateEphemeralKeyPair() {
  return globalThis.crypto.subtle.generateKey(
    {
      name: 'ECDSA',
      namedCurve: 'P-256',
    },
    true,
    ['sign', 'verify'],
  )
}

async function exportP256PublicJwk(publicKey: CryptoKey): Promise<Record<string, string>> {
  const jwk = await globalThis.crypto.subtle.exportKey('jwk', publicKey)
  return {
    kty: String(jwk.kty ?? 'EC'),
    crv: String(jwk.crv ?? 'P-256'),
    x: String(jwk.x ?? ''),
    y: String(jwk.y ?? ''),
  }
}

async function buildSignedPubKeyHeader(args: {
  sender: string
  signer: MessageSigner
  domain: string
  publicKey: CryptoKey
}): Promise<string> {
  const payload = {
    pubkey: await exportP256PublicJwk(args.publicKey),
    alg: 'ECDSA',
    domain: args.domain,
    address: args.sender,
    expires: isoTimestampWithMicros(new Date(Date.now() + 24 * 60 * 60 * 1000)),
    chain: 'ETH',
  }
  const payloadJson = JSON.stringify(payload)
  const signature = normalizeHexSignature(await args.signer(args.sender, payloadJson))

  return JSON.stringify({
    sender: args.sender,
    payload: utf8Hex(payloadJson),
    signature,
    content: {
      domain: args.domain,
    },
  })
}

async function buildSignedOperationHeader(args: {
  privateKey: CryptoKey
  domain: string
  method: string
  path: string
}): Promise<string> {
  const payload = {
    time: isoTimestampWithMicros(),
    method: args.method,
    path: args.path,
    domain: args.domain,
  }
  const payloadJson = JSON.stringify(payload)
  const signature = new Uint8Array(
    await globalThis.crypto.subtle.sign(
      {
        name: 'ECDSA',
        hash: 'SHA-256',
      },
      args.privateKey,
      new TextEncoder().encode(payloadJson),
    ),
  )

  return JSON.stringify({
    payload: utf8Hex(payloadJson),
    signature: bytesToHex(signature),
  })
}

async function fetchInstanceNodeHash(args: {
  instanceHash: string
  fetch: FetchLike
  apiHost?: string
}): Promise<string | null> {
  const envelope = await fetchMessageEnvelope(args.instanceHash, {
    fetch: args.fetch,
    apiHost: args.apiHost,
  })
  const payload = envelope as {
    content?: { requirements?: { node?: { node_hash?: unknown } } } | null
    message?: { content?: { requirements?: { node?: { node_hash?: unknown } } } | null } | null
  } | null

  return (
    asString(payload?.content?.requirements?.node?.node_hash) ??
    asString(payload?.message?.content?.requirements?.node?.node_hash) ??
    null
  )
}

export async function resolveInstanceCrn(args: {
  instanceHash: string
  fetch: FetchLike
  apiHost?: string
  crnUrl?: string | null
  crnHash?: string | null
  crnListUrl?: string
  schedulerAllocationUrl?: string
}): Promise<CrnResolutionResult> {
  const providedCrnUrl = asString(args.crnUrl)
  if (providedCrnUrl) {
    return {
      crnUrl: trimTrailingSlashes(providedCrnUrl),
      crnHash: asString(args.crnHash),
      source: 'provided',
    }
  }

  const allocation = await fetchSchedulerAllocation(args.instanceHash, {
    fetch: args.fetch,
    schedulerAllocationUrl: args.schedulerAllocationUrl ?? DEFAULT_SCHEDULER_ALLOCATION_URL,
  }).catch(() => null)
  if (allocation?.crnUrl) {
    return {
      crnUrl: trimTrailingSlashes(allocation.crnUrl),
      crnHash: asString(allocation.crnHash),
      source: 'scheduler',
    }
  }

  const manualCrnHash =
    asString(args.crnHash) ??
    (await fetchInstanceNodeHash({
      instanceHash: args.instanceHash,
      fetch: args.fetch,
      apiHost: args.apiHost ?? DEFAULT_ALEPH_API_HOST,
    }).catch(() => null))
  if (manualCrnHash) {
    const crns = await fetchCrns({
      url: args.crnListUrl ?? DEFAULT_CRN_LIST_URL,
      fetch: args.fetch,
    }).catch(() => [])
    const matchingCrn = crns.find((candidate) => candidate.hash === manualCrnHash)
    if (matchingCrn?.address) {
      return {
        crnUrl: trimTrailingSlashes(matchingCrn.address),
        crnHash: manualCrnHash,
        source: 'manual',
      }
    }
  }

  return {
    crnUrl: null,
    crnHash: manualCrnHash,
    source: 'missing',
  }
}

export async function eraseInstanceOnCrn(args: {
  sender: string
  signer: MessageSigner
  instanceHash: string
  fetch: FetchLike
  apiHost?: string
  crnUrl?: string | null
  crnHash?: string | null
  crnListUrl?: string
  schedulerAllocationUrl?: string
}): Promise<CrnEraseResult> {
  const resolution = await resolveInstanceCrn({
    instanceHash: args.instanceHash,
    fetch: args.fetch,
    apiHost: args.apiHost,
    crnUrl: args.crnUrl,
    crnHash: args.crnHash,
    crnListUrl: args.crnListUrl,
    schedulerAllocationUrl: args.schedulerAllocationUrl,
  })
  if (!resolution.crnUrl) {
    return {
      ...resolution,
      status: 'skipped',
    }
  }

  const crnUrl = new URL(resolution.crnUrl)
  const domain = crnUrl.host
  const path = `/control/machine/${args.instanceHash}/erase`
  const { privateKey, publicKey } = await generateEphemeralKeyPair()
  const signedPubKeyHeader = await buildSignedPubKeyHeader({
    sender: args.sender,
    signer: args.signer,
    domain,
    publicKey,
  })
  const signedOperationHeader = await buildSignedOperationHeader({
    privateKey,
    domain,
    method: 'POST',
    path,
  })

  const response = await args.fetch(`${trimTrailingSlashes(resolution.crnUrl)}${path}`, {
    method: 'POST',
    headers: {
      'X-SignedPubKey': signedPubKeyHeader,
      'X-SignedOperation': signedOperationHeader,
    },
  })

  if (response.status === 404) {
    return {
      ...resolution,
      status: 'missing',
    }
  }

  if (response.ok) {
    return {
      ...resolution,
      status: 'erased',
    }
  }

  const errorBody = await response
    .json()
    .then((payload) => JSON.stringify(payload))
    .catch(() => '')
  throw new Error(
    `CRN erase failed for ${args.instanceHash} on ${resolution.crnUrl}: ${response.status}${errorBody ? ` ${errorBody}` : ''}`,
  )
}
