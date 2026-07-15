import process from "node:process"
import { createHash } from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"
import { importer as importUnixfs } from "ipfs-unixfs-importer"
import { CarWriter } from "@ipld/car/writer"
import { CID } from "multiformats/cid"

import { broadcastAlephMessage, DEFAULT_ALEPH_CHANNEL, forgetAlephMessages, normalizeBroadcastStatus, publishAggregateKey, signAlephMessage } from "../../core/src/index.ts"
import { inspectMessageResult, isTransientMessageLookupError } from "../../core/src/deployment-inspection.ts"

import { optionalEnv, requiredEnv } from "./env.ts"
import { appendGithubOutput, appendGithubSummary } from "./github-outputs.ts"
import type { RelayProbeResult } from "./relay-probe.ts"
import { createPrivateKeyIdentity } from "./signer.ts"
import { attachAlephDomain } from "./domain-link.ts"

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'
const DAG_PB_CODEC = 0x70

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/u, '')
}

function uniqueNonEmptyValues(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of values) {
    const value = normalizeUrl(raw)
    if (!value || seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

function parseCsvOrWhitespaceList(raw: string): string[] {
  return raw.split(/[\s,]+/u)
}

interface SiteEndpointPair {
  ipfsGateway: string
  apiHost: string
}

function siteAlephApiHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  const rawHosts =
    optionalEnv('ALEPH_SITE_ALEPH_API_HOSTS', '', env).trim() ||
    optionalEnv('ALEPH_SITE_ALEPH_API_HOST', 'https://api2.aleph.im', env).trim()
  const hosts = uniqueNonEmptyValues(parseCsvOrWhitespaceList(rawHosts))
  if (hosts.length === 0) {
    throw new Error('ALEPH_SITE_ALEPH_API_HOSTS did not contain any API host URLs.')
  }
  return hosts
}

function siteEndpointPairs(env: NodeJS.ProcessEnv = process.env): SiteEndpointPair[] {
  const configured = optionalEnv('ALEPH_SITE_ENDPOINT_PAIRS', '', env).trim()
  if (configured) {
    let parsed: unknown
    try {
      parsed = JSON.parse(configured)
    } catch (error) {
      throw new Error(`ALEPH_SITE_ENDPOINT_PAIRS must be valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!Array.isArray(parsed)) throw new Error('ALEPH_SITE_ENDPOINT_PAIRS must be a JSON array.')
    const pairs = parsed.map((entry, index) => {
      if (!entry || typeof entry !== 'object') throw new Error(`ALEPH_SITE_ENDPOINT_PAIRS[${index}] must be an object.`)
      const record = entry as Record<string, unknown>
      if (typeof record.ipfsGateway !== 'string' || typeof record.apiHost !== 'string') {
        throw new Error(`ALEPH_SITE_ENDPOINT_PAIRS[${index}] requires string ipfsGateway and apiHost values.`)
      }
      return { ipfsGateway: normalizeUrl(record.ipfsGateway), apiHost: normalizeUrl(record.apiHost) }
    })
    if (pairs.length === 0) throw new Error('ALEPH_SITE_ENDPOINT_PAIRS must contain at least one endpoint pair.')
    return pairs
  }

  const gateways = siteIpfsGateways(env)
  const apiHosts = siteAlephApiHosts(env)
  if (gateways.length !== apiHosts.length && (gateways.length > 1 || apiHosts.length > 1)) {
    throw new Error('Legacy ALEPH_SITE_IPFS_GATEWAYS and ALEPH_SITE_ALEPH_API_HOSTS must have equal lengths; prefer ALEPH_SITE_ENDPOINT_PAIRS.')
  }
  return gateways.map((ipfsGateway, index) => ({ ipfsGateway, apiHost: apiHosts[index] ?? apiHosts[0]! }))
}

function siteIpfsGateways(env: NodeJS.ProcessEnv = process.env): string[] {
  const rawGateways =
    optionalEnv('ALEPH_SITE_IPFS_GATEWAYS', '', env).trim() ||
    optionalEnv('ALEPH_SITE_IPFS_GATEWAY', 'https://ipfs-2.aleph.im', env).trim()
  const gateways = uniqueNonEmptyValues(parseCsvOrWhitespaceList(rawGateways))
  if (gateways.length === 0) {
    throw new Error('ALEPH_SITE_IPFS_GATEWAYS did not contain any IPFS gateway URLs.')
  }
  return gateways
}

async function withAlephApiHostFallback<T>(args: {
  label: string
  env?: NodeJS.ProcessEnv
  run: (apiHost: string) => Promise<T>
}): Promise<{ result: T; apiHost: string }> {
  const apiHosts = siteAlephApiHosts(args.env)
  let lastError: unknown = null

  for (const [index, apiHost] of apiHosts.entries()) {
    try {
      if (apiHosts.length > 1) {
        console.warn(`Aleph ${args.label} API host attempt ${index + 1}/${apiHosts.length}: ${apiHost}`)
      }
      return { result: await args.run(apiHost), apiHost }
    } catch (error) {
      lastError = error
      if (index < apiHosts.length - 1) {
        const message = error instanceof Error ? error.message : String(error)
        console.warn(
          `Aleph ${args.label} API host ${apiHost} failed; retrying with ${apiHosts[index + 1]}. ${message}`,
        )
      }
    }
  }

  const suffix = lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error(
    `Aleph ${args.label} failed through all configured API hosts (${apiHosts.join(', ')}). Last error: ${suffix}`,
  )
}

export function parseLastJsonObject(text: string): Record<string, unknown> {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const candidate = lines[index]?.trimStart() ?? ''
    if (!candidate.startsWith('{')) continue
    const suffix = lines.slice(index).join('\n')
    try {
      return JSON.parse(suffix) as Record<string, unknown>
    } catch {
      // Keep scanning upward until we find a complete trailing JSON object.
    }
  }
  throw new Error(`Could not parse JSON object from output: ${text}`)
}

async function waitForAlephMessage(itemHash: string, apiHost: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const attempts = Number(optionalEnv('ALEPH_SITE_ALEPH_MESSAGE_WAIT_ATTEMPTS', '60', env))
  const delayMs = Number(optionalEnv('ALEPH_SITE_ALEPH_MESSAGE_WAIT_DELAY_MS', '5000', env))

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await inspectMessageResult(itemHash, {
        apiHost,
        fetch: fetch,
        label: 'Aleph STORE message',
      })
      if (result.status === 'processed') return true
      if (result.status === 'rejected') {
        throw new Error(result.rejectionReason ?? `Aleph STORE message ${itemHash} was rejected.`)
      }
    } catch (error) {
      if (!isTransientMessageLookupError(error) || attempt >= attempts) {
        throw error
      }
    }
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }

  return false
}

function responseMatchesCid(response: Response, cidV0: string): boolean {
  const etag = (response.headers.get('etag') ?? '').replace(/^W\//u, '').replaceAll('"', '')
  const roots = (response.headers.get('x-ipfs-roots') ?? '').split(/[\s,]+/u)
  return etag === cidV0 || roots.includes(cidV0)
}

async function waitForPublicCid(args: {
  url: string
  cidV0: string
  env?: NodeJS.ProcessEnv
  label: string
}): Promise<void> {
  const env = args.env ?? process.env
  const attempts = Number(optionalEnv('ALEPH_SITE_GATEWAY_WAIT_ATTEMPTS', '60', env))
  const delayMs = Number(optionalEnv('ALEPH_SITE_GATEWAY_WAIT_DELAY_MS', '5000', env))
  let lastEvidence = 'no response'
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(args.url, { cache: 'no-cache', redirect: 'follow' })
      const body = response.ok ? await response.text() : ''
      const cidMatches = responseMatchesCid(response, args.cidV0)
      const usableIndex = /<(?:!doctype|html|head|body)\b/iu.test(body)
      lastEvidence = `HTTP ${response.status}, cidMatches=${cidMatches}, usableIndex=${usableIndex}`
      if (response.ok && cidMatches && usableIndex) return
    } catch (error) {
      lastEvidence = error instanceof Error ? error.message : String(error)
    }
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  throw new Error(`${args.label} did not serve expected CID ${args.cidV0}: ${lastEvidence}`)
}

interface SitePublishResult {
  cidV0: string
  cidV1: string
}

class RecordingBlockstore {
  readonly blocks = new Map<string, { cid: any; bytes: Uint8Array }>()

  async put(cid: any, bytes: Uint8Array): Promise<unknown> {
    this.blocks.set(cid.toString(), { cid, bytes })
    return cid
  }
}

interface StaticSiteCar {
  rootCid: any
  rootCidV0: string
  rootCidV1: string
  bytes: Uint8Array
}

interface AlephStoreContent {
  address: string
  time: number
  item_type: 'ipfs'
  item_hash: string
  payment: { type: 'credit' }
  ref?: string
}

function encodeVarint(value: number): Uint8Array {
  const bytes: number[] = []
  let remaining = value >>> 0
  while (remaining >= 0x80) {
    bytes.push((remaining & 0x7f) | 0x80)
    remaining >>>= 7
  }
  bytes.push(remaining)
  return Uint8Array.from(bytes)
}

function decodeBase58(value: string): Uint8Array {
  if (!value) throw new Error('CID v0 must be a non-empty base58btc string.')
  const digits = [0]
  for (const character of value) {
    const alphabetIndex = BASE58_ALPHABET.indexOf(character)
    if (alphabetIndex < 0) {
      throw new Error(`Invalid base58btc character "${character}" in CID v0 "${value}".`)
    }
    let carry = alphabetIndex
    for (let index = 0; index < digits.length; index += 1) {
      const next = digits[index]! * 58 + carry
      digits[index] = next & 0xff
      carry = next >> 8
    }
    while (carry > 0) {
      digits.push(carry & 0xff)
      carry >>= 8
    }
  }

  let leadingZeroCount = 0
  while (leadingZeroCount < value.length && value[leadingZeroCount] === '1') {
    leadingZeroCount += 1
  }

  const decoded = new Uint8Array(leadingZeroCount + digits.length)
  for (let index = 0; index < digits.length; index += 1) {
    decoded[decoded.length - 1 - index] = digits[index]!
  }
  return decoded
}

function encodeBase32LowerNoPad(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let output = 'b'
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  }
  return output
}

export function cidV0ToV1(cidV0: string): string {
  const multihash = decodeBase58(cidV0)
  const prefix = new Uint8Array([...encodeVarint(1), ...encodeVarint(DAG_PB_CODEC)])
  const cidV1Bytes = new Uint8Array(prefix.length + multihash.length)
  cidV1Bytes.set(prefix, 0)
  cidV1Bytes.set(multihash, prefix.length)
  return encodeBase32LowerNoPad(cidV1Bytes)
}

async function collectFiles(folder: string, base = folder): Promise<Array<{ relativePath: string; bytes: Uint8Array }>> {
  const entries = await readdir(folder, { withFileTypes: true })
  const files: Array<{ relativePath: string; bytes: Uint8Array }> = []
  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    const fullPath = join(folder, entry.name)
    if (entry.isDirectory()) {
      files.push(...await collectFiles(fullPath, base))
      continue
    }
    if (!entry.isFile()) continue
    files.push({
      relativePath: relative(base, fullPath),
      bytes: await readFile(fullPath),
    })
  }
  return files
}

export async function buildStaticSiteCar(directory: string): Promise<StaticSiteCar> {
  const files = await collectFiles(directory)
  if (files.length === 0) throw new Error(`No files found under ${directory}`)
  const blockstore = new RecordingBlockstore()
  let rootCid: any
  for await (const entry of importUnixfs(
    files.map((file) => ({ path: file.relativePath, content: file.bytes })),
    blockstore as any,
    { cidVersion: 1, rawLeaves: true, wrapWithDirectory: true },
  )) {
    rootCid = entry.cid
  }
  if (!rootCid) throw new Error(`Could not compute wrapped UnixFS directory CID for ${directory}.`)

  const { writer, out } = CarWriter.create([rootCid])
  const chunksPromise = (async () => {
    const chunks: Uint8Array[] = []
    for await (const chunk of out) chunks.push(chunk)
    const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return bytes
  })()
  for (const block of blockstore.blocks.values()) await writer.put(block)
  await writer.close()
  const rootCidV1 = rootCid.toString()
  const rootCidV0 = rootCid.toV0().toString()
  return { rootCid, rootCidV0, rootCidV1, bytes: await chunksPromise }
}

export async function computeStaticSiteDirectoryCid(directory: string): Promise<SitePublishResult> {
  const car = await buildStaticSiteCar(directory)
  return { cidV0: car.rootCidV0, cidV1: car.rootCidV1 }
}

export async function uploadStaticSiteDirectory(directory: string, gateway: string): Promise<SitePublishResult> {
  const files = await collectFiles(directory)
  if (files.length === 0) {
    throw new Error(`No files found under ${directory}`)
  }

  const formData = new FormData()
  for (const file of files) {
    const arrayBuffer = file.bytes.buffer.slice(
      file.bytes.byteOffset,
      file.bytes.byteOffset + file.bytes.byteLength
    ) as ArrayBuffer
    formData.append('file', new File([arrayBuffer], file.relativePath))
  }

  const url = new URL('/api/v0/add', gateway)
  url.searchParams.set('recursive', 'true')
  url.searchParams.set('wrap-with-directory', 'true')
  url.searchParams.set('cid-version', '1')
  url.searchParams.set('raw-leaves', 'true')

  const response = await fetch(url, {
    method: 'POST',
    body: formData,
  })
  if (!response.ok) {
    throw new Error(`IPFS add request failed with ${response.status} ${response.statusText}`)
  }

  const responseText = await response.text()
  let cidV0 = ''
  for (const line of responseText.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const payload = JSON.parse(trimmed) as { Name?: string; Hash?: string }
    if (payload.Name === '' && payload.Hash) cidV0 = payload.Hash
  }
  if (!cidV0) {
    throw new Error('CID not found in IPFS response')
  }

  const parsed = CID.parse(cidV0)
  return { cidV0: parsed.toV0().toString(), cidV1: parsed.toV1().toString() }
}

async function uploadStaticSiteDirectoryWithGatewayFallback(
  directory: string,
  expected: SitePublishResult,
  env: NodeJS.ProcessEnv = process.env,
  onVerified?: (endpointPair: SiteEndpointPair, publish: SitePublishResult) => Promise<void>,
): Promise<{ publish: SitePublishResult; endpointPair: SiteEndpointPair }> {
  const pairs = siteEndpointPairs(env)
  let lastError: unknown = null

  for (const [index, endpointPair] of pairs.entries()) {
    try {
      if (pairs.length > 1) {
        console.warn(`Aleph site endpoint pair attempt ${index + 1}/${pairs.length}: ${endpointPair.ipfsGateway} + ${endpointPair.apiHost}`)
      }
      const publish = await uploadStaticSiteDirectory(directory, endpointPair.ipfsGateway)
      if (publish.cidV0 !== expected.cidV0) {
        throw new Error(`Static site CID mismatch before STORE publication: expected ${expected.cidV1}, uploaded ${publish.cidV1}. Options: cidVersion=1, rawLeaves=true, wrapWithDirectory=true.`)
      }
      await onVerified?.(endpointPair, publish)
      return { publish, endpointPair }
    } catch (error) {
      lastError = error
      if (index < pairs.length - 1) {
        const message = error instanceof Error ? error.message : String(error)
        console.warn(
          `Aleph site endpoint pair ${endpointPair.ipfsGateway} + ${endpointPair.apiHost} failed; retrying with the next pair. ${message}`,
        )
      }
    }
  }

  const suffix = lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error(
    `Aleph site IPFS upload failed through all configured endpoint pairs. Last error: ${suffix}`,
  )
}

interface AlephMessageListEntry {
  item_hash?: unknown
  time?: unknown
  sender?: unknown
  item_content?: unknown
  content?: unknown
}

interface ScopedSiteStoreRecord {
  itemHash: string
  time: number
}

function mergedAddrs(env: NodeJS.ProcessEnv = process.env): string[] {
  const combined: string[] = []
  for (const key of ['PROBE_MULTIADDRS_JSON', 'BROWSER_BOOTSTRAP_MULTIADDRS_JSON']) {
    const raw = env[key] ?? '[]'
    for (const value of JSON.parse(raw)) {
      if (typeof value === 'string') {
        const trimmed = value.trim()
        if (trimmed) combined.push(trimmed)
      }
    }
  }
  return Array.from(new Set(combined))
}

export interface BrowserTransportCerthashVerification {
  ok: boolean
  profile: string
  webtransport: string[]
  webrtcDirect: string[]
  missingCerthash: string[]
  errors: string[]
}

export function verifyBrowserTransportCerthashes(
  addrs: string[],
  profile = '',
): BrowserTransportCerthashVerification {
  const normalizedProfile = profile.trim().toLowerCase()
  const webtransport = addrs.filter((addr) => addr.toLowerCase().includes('/webtransport/'))
  const webrtcDirect = addrs.filter((addr) => addr.toLowerCase().includes('/webrtc-direct/'))
  const directBrowserAddrs = [...webtransport, ...webrtcDirect]
  const missingCerthash = directBrowserAddrs.filter(
    (addr) => !addr.toLowerCase().includes('/certhash/'),
  )
  const errors: string[] = []

  if (normalizedProfile === 'uc-go-peer') {
    if (webtransport.length === 0) {
      errors.push('uc-go-peer did not advertise a WebTransport multiaddress.')
    }
    if (webrtcDirect.length === 0) {
      errors.push('uc-go-peer did not advertise a WebRTC Direct multiaddress.')
    }
  }
  if (missingCerthash.length > 0) {
    errors.push(
      `${missingCerthash.length} WebTransport/WebRTC Direct multiaddress(es) are missing /certhash/.`,
    )
  }

  return {
    ok: errors.length === 0,
    profile: normalizedProfile,
    webtransport,
    webrtcDirect,
    missingCerthash,
    errors,
  }
}

function defaultHasher(payload: string): string {
  return createHash('sha256').update(payload).digest('hex')
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (!value) return null
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      return parseJsonRecord(parsed)
    } catch {
      return null
    }
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return null
}

function parseMessageTime(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

async function fetchScopedSiteStoreRecords(args: {
  sender: string
  ref: string
  apiHost: string
}): Promise<ScopedSiteStoreRecord[]> {
  const requestUrl = new URL('/api/v0/messages.json', args.apiHost)
  requestUrl.searchParams.set('msgTypes', 'STORE')
  requestUrl.searchParams.set('addresses', args.sender)
  requestUrl.searchParams.set('message_statuses', 'processed,pending')
  requestUrl.searchParams.set('pagination', '100')
  requestUrl.searchParams.set('page', '1')
  requestUrl.searchParams.set('sortOrder', '-1')

  const response = await fetch(requestUrl, { cache: 'no-cache' })
  if (!response.ok) {
    throw new Error(`Aleph STORE list request failed: ${response.status}`)
  }

  const payload = (await response.json()) as { messages?: AlephMessageListEntry[] }
  const messages = Array.isArray(payload.messages) ? payload.messages : []

  return messages.flatMap((message) => {
    const itemHash = typeof message.item_hash === 'string' && message.item_hash.trim() ? message.item_hash : null
    if (!itemHash) return []
    const itemContent = parseJsonRecord(message.item_content) ?? parseJsonRecord(message.content)
    if (!itemContent) return []
    if (itemContent.item_type !== 'ipfs') return []
    if (itemContent.ref !== args.ref) return []
    return [{
      itemHash,
      time: Math.max(parseMessageTime(message.time), parseMessageTime(itemContent.time)),
    }]
  })
}

async function retainRecentSiteStores(args: {
  currentItemHash: string
  apiHost: string
  env?: NodeJS.ProcessEnv
}): Promise<void> {
  const env = args.env ?? process.env
  const keepCount = Number(optionalEnv('ALEPH_SITE_RETENTION_KEEP_COUNT', '0', env))
  if (!Number.isFinite(keepCount) || keepCount <= 0) return

  const ref = optionalEnv('ALEPH_SITE_REF', '', env).trim()
  if (!ref) {
    throw new Error('ALEPH_SITE_RETENTION_KEEP_COUNT requires ALEPH_SITE_REF so retention only forgets uploads for one site.')
  }

  const privateKey = requiredEnv('ALEPH_PRIVATE_KEY', env)
  const channel = optionalEnv('ALEPH_SITE_CHANNEL', DEFAULT_ALEPH_CHANNEL, env)
  const identity = await createPrivateKeyIdentity(privateKey)
  const records = await fetchScopedSiteStoreRecords({
    sender: identity.address,
    ref,
    apiHost: args.apiHost,
  })

  const overflowHashes = records
    .filter((record) => record.itemHash !== args.currentItemHash)
    .sort((left, right) => right.time - left.time)
    .slice(Math.max(keepCount - 1, 0))
    .map((record) => record.itemHash)

  if (overflowHashes.length === 0) return

  const result = await forgetAlephMessages({
    sender: identity.address,
    hashes: overflowHashes,
    reason: `Retain only the latest ${keepCount} site upload(s) for ${ref}`,
    signer: identity.signer,
    hasher: async (payload) => defaultHasher(payload),
    fetch,
    channel,
    apiHost: args.apiHost,
    sync: true,
  })

  if (result.status === 'rejected') {
    throw new Error(`Aleph site retention forget was rejected: ${JSON.stringify(result.response ?? {})}`)
  }
}

async function publishWebsiteAggregate(args: {
  itemHash: string
  apiHost: string
  env?: NodeJS.ProcessEnv
}): Promise<string> {
  const env = args.env ?? process.env
  const name = optionalEnv('ALEPH_SITE_NAME', '', env).trim()
  if (!name) return ''
  const identity = await createPrivateKeyIdentity(requiredEnv('ALEPH_PRIVATE_KEY', env))
  const channel = optionalEnv('ALEPH_SITE_CHANNEL', DEFAULT_ALEPH_CHANNEL, env)
  const now = Date.now() / 1000
  const aggregateUrl = new URL(`/api/v0/aggregates/${identity.address}.json`, args.apiHost)
  aggregateUrl.searchParams.set('keys', 'websites')
  let previous: Record<string, unknown> | undefined
  try {
    const response = await fetch(aggregateUrl, { cache: 'no-cache' })
    if (response.ok) {
      const payload = await response.json() as Record<string, any>
      previous = payload.data?.websites?.[name] ?? payload.websites?.[name]
    }
  } catch {
    // A missing aggregate is equivalent to the first website version.
  }
  const previousVersion = typeof previous?.version === 'number' ? previous.version : 0
  const previousVolume = typeof previous?.volume_id === 'string' ? previous.volume_id : ''
  const history = previous?.history && typeof previous.history === 'object'
    ? { ...(previous.history as Record<string, string>) }
    : {}
  if (previousVersion > 0 && previousVolume) history[String(previousVersion)] = previousVolume
  const entry = {
    metadata: { name, tags: [], framework: optionalEnv('ALEPH_SITE_FRAMEWORK', 'static', env) },
    payment: { chain: 'ETH', type: 'credit' },
    version: previousVersion + 1,
    volume_id: args.itemHash,
    history,
    ens: Array.isArray(previous?.ens) ? previous.ens : [],
    created_at: typeof previous?.created_at === 'number' ? previous.created_at : now,
    updated_at: now,
  }
  const result = await publishAggregateKey({
    sender: identity.address,
    key: 'websites',
    content: { [name]: entry },
    signer: identity.signer,
    hasher: async (payload) => defaultHasher(payload),
    fetch,
    channel,
    apiHost: args.apiHost,
    broadcastAttempts: 3,
  })
  if (result.status === 'rejected') throw new Error(`Aleph websites aggregate was rejected: ${JSON.stringify(result.response ?? {})}`)
  return result.itemHash
}

async function buildSiteStoreMessage(cid: string, env: NodeJS.ProcessEnv = process.env) {
  const privateKey = requiredEnv('ALEPH_PRIVATE_KEY', env)
  const channel = optionalEnv('ALEPH_SITE_CHANNEL', DEFAULT_ALEPH_CHANNEL, env)
  const identity = await createPrivateKeyIdentity(privateKey)
  const now = Date.now() / 1000
  const content: AlephStoreContent = {
    address: identity.address,
    time: now,
    item_type: 'ipfs',
    item_hash: cid,
    payment: { type: 'credit' },
  }
  const itemContent = JSON.stringify(content)
  const unsignedMessage = {
    sender: identity.address,
    chain: 'ETH' as const,
    type: 'STORE' as const,
    item_hash: defaultHasher(itemContent),
    item_type: 'inline' as const,
    item_content: itemContent,
    time: now,
    channel,
  }
  return signAlephMessage(unsignedMessage, identity.signer)
}

async function pinIpfsCidOnAleph(cidV0: string, apiHost: string, env: NodeJS.ProcessEnv = process.env): Promise<{ itemHash: string; apiHost: string }> {
  const message = await buildSiteStoreMessage(cidV0, env)
  const attempts = Number(optionalEnv('ALEPH_SITE_STORE_BROADCAST_ATTEMPTS', '3', env))
  const { response, httpStatus } = await broadcastAlephMessage(message, {
        apiHost,
        sync: true,
        fetch,
        attempts,
      })
      const status = normalizeBroadcastStatus(httpStatus, response?.message_status)
      if (status === 'rejected') {
        throw new Error(`Aleph STORE pin was rejected: ${JSON.stringify(response?.details ?? response ?? {})}`)
      }
      const itemHash = typeof response?.item_hash === 'string' ? response.item_hash : message.item_hash
      if (!itemHash) {
        throw new Error(`Aleph pin response did not include item_hash: ${JSON.stringify(response ?? {})}`)
      }
  return { itemHash, apiHost }
}

async function uploadStaticSiteCarAuthenticated(args: {
  car: StaticSiteCar
  apiHost: string
  env?: NodeJS.ProcessEnv
}): Promise<{ itemHash: string; apiHost: string }> {
  const env = args.env ?? process.env
  const message = await buildSiteStoreMessage(args.car.rootCidV1, env)
  const form = new FormData()
  const carBuffer = args.car.bytes.buffer.slice(
    args.car.bytes.byteOffset,
    args.car.bytes.byteOffset + args.car.bytes.byteLength,
  ) as ArrayBuffer
  form.append('file', new File([carBuffer], 'upload.car', { type: 'application/vnd.ipld.car' }))
  form.append('metadata', new Blob([
    JSON.stringify({ message, sync: true }),
  ], { type: 'application/json' }))

  const response = await fetch(new URL('/api/v0/ipfs/add_car', args.apiHost), {
    method: 'POST',
    body: form,
  })
  const responseText = await response.text()
  if (!response.ok) {
    throw new Error(`Authenticated Aleph CAR upload failed: HTTP ${response.status} ${responseText}`)
  }
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(responseText) as Record<string, unknown>
  } catch {
    throw new Error(`Authenticated Aleph CAR upload returned invalid JSON: ${responseText}`)
  }
  const serverCid = typeof payload.hash === 'string' ? payload.hash : ''
  if (serverCid !== args.car.rootCidV1) {
    throw new Error(`Authenticated Aleph CAR upload root mismatch: expected ${args.car.rootCidV1}, received ${serverCid || '<missing>'}.`)
  }
  return { itemHash: message.item_hash, apiHost: args.apiHost }
}

export async function runSitePublishMode(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const projectDir = optionalEnv('ALEPH_SITE_PROJECT_DIR', process.cwd(), env)
  const siteDirectoryInput = requiredEnv('ALEPH_SITE_DIRECTORY', env)
  const siteDirectory = isAbsolute(siteDirectoryInput)
    ? siteDirectoryInput
    : resolve(projectDir, siteDirectoryInput)
  const pin = optionalEnv('ALEPH_SITE_PIN', 'true', env) === 'true'

  const uploadDriver = optionalEnv('ALEPH_SITE_UPLOAD_DRIVER', 'authenticated-car', env).trim()
  const car = await buildStaticSiteCar(siteDirectory)
  const expected = { cidV0: car.rootCidV0, cidV1: car.rootCidV1 }
  let pinned: { itemHash: string; apiHost: string } | undefined
  let publish: SitePublishResult
  let endpointPair: SiteEndpointPair
  if (pin && uploadDriver === 'authenticated-car') {
    endpointPair = siteEndpointPairs(env)[0]!
    pinned = await uploadStaticSiteCarAuthenticated({ car, apiHost: endpointPair.apiHost, env })
    publish = expected
  } else {
    const legacy = await uploadStaticSiteDirectoryWithGatewayFallback(
      siteDirectory,
      expected,
      env,
      pin ? async (pair, uploaded) => {
        pinned = await pinIpfsCidOnAleph(uploaded.cidV1, pair.apiHost, env)
      } : undefined,
    )
    publish = legacy.publish
    endpointPair = legacy.endpointPair
  }
  const cidV0 = publish.cidV0
  const cidV1 = publish.cidV1

  await appendGithubOutput('ipfs_cid_v0', cidV0, env)
  await appendGithubOutput('ipfs_cid_v1', cidV1, env)
  await appendGithubOutput('ipfs_cid', cidV1, env)
  await appendGithubOutput('local_ipfs_cid_v0', expected.cidV0, env)
  await appendGithubOutput('uploaded_ipfs_cid_v0', publish.cidV0, env)
  await appendGithubOutput('cid_match', String(expected.cidV0 === publish.cidV0), env)
  await appendGithubOutput('ipfs_gateway', endpointPair.ipfsGateway, env)
  await appendGithubOutput('aleph_api_host', endpointPair.apiHost, env)
  await appendGithubOutput('site_upload_driver', uploadDriver, env)
  await appendGithubOutput('url', `https://${cidV1}.ipfs.aleph.sh`, env)

  let itemHash = ''
  let websiteAggregateHash = ''
  let storeStatus = pin ? 'pending' : 'not-requested'
  let directGatewayVerified = false
  if (pin) {
    if (!pinned) throw new Error('Static site upload completed without an Aleph STORE result.')
    itemHash = pinned.itemHash
    await appendGithubOutput('item_hash', itemHash, env)
    const processed = await waitForAlephMessage(itemHash, pinned.apiHost, env)
    if (processed) {
      storeStatus = 'processed'
      await waitForPublicCid({
        url: `https://${cidV1}.ipfs.aleph.sh`,
        cidV0: cidV1,
        env,
        label: 'Direct CID gateway',
      })
      directGatewayVerified = true
      websiteAggregateHash = await publishWebsiteAggregate({ itemHash, apiHost: pinned.apiHost, env })
      await retainRecentSiteStores({ currentItemHash: itemHash, apiHost: pinned.apiHost, env })
    } else {
      const allowPending = optionalEnv('ALEPH_SITE_ALLOW_PENDING_STORE', 'false', env) === 'true'
      if (!allowPending) {
        throw new Error(
          `Aleph STORE message ${itemHash} stayed pending after the wait window. ` +
          'The site was uploaded to IPFS, but it is not safe to link a custom domain yet. ' +
          'Retry publication after Aleph processes the STORE. Set ALEPH_SITE_ALLOW_PENDING_STORE=true only for asynchronous workflows that do not link a domain.',
        )
      }
      console.warn(`Aleph STORE message ${itemHash} stayed pending; continuing because ALEPH_SITE_ALLOW_PENDING_STORE=true.`)
    }
  }

  await appendGithubOutput('store_status', storeStatus, env)
  await appendGithubOutput('store_processed', String(storeStatus === 'processed'), env)
  await appendGithubOutput('direct_gateway_verified', String(directGatewayVerified), env)
  await appendGithubOutput('website_aggregate_hash', websiteAggregateHash, env)

  await appendGithubSummary([
    '## Aleph Site Runner',
    '',
    `- Site directory: \`${siteDirectory}\``,
    `- Locally computed CID v0: \`${expected.cidV0}\``,
    `- IPFS CID v0: \`${cidV0}\``,
    `- CID match: \`${expected.cidV0 === publish.cidV0}\``,
    `- IPFS CID v1: \`${cidV1}\``,
    `- Aleph item hash: \`${itemHash}\``,
    `- Aleph STORE status: \`${storeStatus}\``,
    `- Endpoint pair: \`${endpointPair.ipfsGateway} + ${endpointPair.apiHost}\``,
    `- Upload driver: \`${uploadDriver}\``,
    `- Direct CID gateway verified: \`${directGatewayVerified}\``,
    `- Website aggregate hash: \`${websiteAggregateHash || 'not-requested'}\``,
  ], env)
}

export async function runDomainLinkMode(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const privateKey = requiredEnv('ALEPH_PRIVATE_KEY', env)
  const domain = requiredEnv('ALEPH_SITE_DOMAIN', env)
  const itemHash = requiredEnv('ALEPH_SITE_ITEM_HASH', env)
  const cidV0 = (
    optionalEnv('ALEPH_SITE_IPFS_CID', '', env).trim() ||
    optionalEnv('ALEPH_SITE_IPFS_CID_V0', '', env).trim()
  )
  const catchAllPath = optionalEnv('ALEPH_SITE_DOMAIN_CATCH_ALL_PATH', '/index.html', env)
  const identity = await createPrivateKeyIdentity(privateKey)

  const { result: attachPublication } = await withAlephApiHostFallback({
    label: 'site domain link',
    env,
    run: async (apiHost) => {
      const processed = await waitForAlephMessage(itemHash, apiHost, env)
      if (!processed) {
        throw new Error(
          `Refusing to link ${domain}: Aleph STORE message ${itemHash} is still pending. ` +
          'Custom domains may only target processed STORE messages.',
        )
      }

      return attachAlephDomain({
        sender: identity.address,
        domain,
        itemHash,
        kind: 'ipfs',
        options: catchAllPath.startsWith('/') ? { catch_all_path: catchAllPath } : null,
        signer: identity.signer,
        hasher: async (payload) => defaultHasher(payload),
        fetch,
        apiHost,
        broadcastAttempts: 1,
      })
    },
  })

  await appendGithubOutput('domain', attachPublication.domain, env)
  await appendGithubOutput('item_hash', itemHash, env)
  await appendGithubOutput('url', `https://${attachPublication.domain}`, env)
  await appendGithubOutput('domain_message_hash', attachPublication.aggregateItemHash, env)

  let domainVerified = false
  if (cidV0) {
    await waitForPublicCid({ url: `https://${attachPublication.domain}`, cidV0, env, label: 'Custom domain' })
    domainVerified = true
    await appendGithubOutput('domain_verified_cid', cidV0, env)
  }
  await appendGithubOutput('domain_verified', String(domainVerified), env)

  await appendGithubSummary([
    '## Aleph Site Runner',
    '',
    `- Linked domain: \`${attachPublication.domain}\``,
    `- Aleph item hash: \`${itemHash}\``,
    `- Domain aggregate hash: \`${attachPublication.aggregateItemHash}\``,
    `- Verified domain CID: \`${cidV0 || 'not-requested'}\``,
    `- Public domain verified: \`${domainVerified}\``,
    `- Catch-all path: \`${catchAllPath}\``,
  ], env)
}

export async function runProbeMode(
  env: NodeJS.ProcessEnv = process.env,
  options: { probe?: (addrs: string[], env: NodeJS.ProcessEnv) => Promise<RelayProbeResult[]> } = {}
): Promise<void> {
  const addrs = mergedAddrs(env)
  if (addrs.length === 0) throw new Error('No relay probe or browser bootstrap multiaddrs were supplied.')
  const certhashVerification = verifyBrowserTransportCerthashes(
    addrs,
    env.ALEPH_RELAY_PROFILE ?? env.ALEPH_ROOTFS_PROFILE ?? '',
  )
  await appendGithubOutput('certhash_verification_json', JSON.stringify(certhashVerification), env)
  await appendGithubOutput('certhash_verification_ok', String(certhashVerification.ok), env)
  if (!certhashVerification.ok) {
    throw new Error(`Browser transport certhash verification failed: ${certhashVerification.errors.join(' ')}`)
  }
  const probe = options.probe ?? (await import('./relay-probe.ts')).probeRelayAddrs
  const rows = await probe(addrs, env)
  if (rows.length === 0) throw new Error('Relay probe produced no JSON output.')

  const json = rows.map((row) => JSON.stringify(row)).join('\n')
  if (json) process.stdout.write(`${json}\n`)

  if (rows.some((row) => row.required && row.ok !== true)) {
    throw new Error('At least one required relay protocol probe failed.')
  }

  await appendGithubOutput('ok', 'true', env)
  await appendGithubOutput('json', json, env)
  await appendGithubOutput('merged_multiaddrs_json', JSON.stringify(addrs), env)
}

export async function runBootstrapEnvMode(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const raw = env.BROWSER_BOOTSTRAP_MULTIADDRS_JSON ?? '[]'
  const addrs = JSON.parse(raw)
    .filter((value: unknown): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value: string) => value.trim())
  const csv = addrs.join(',')

  await appendGithubOutput('json', JSON.stringify(addrs), env)
  await appendGithubOutput('csv', csv, env)
  await appendGithubOutput('count', String(addrs.length), env)
  await appendGithubOutput('available', addrs.length > 0 ? 'true' : 'false', env)
}

export async function runSiteMode(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const mode = optionalEnv('ALEPH_VM_MODE', 'site-publish', env)
  if (mode === 'site-publish') return await runSitePublishMode(env)
  if (mode === 'site-domain-link') return await runDomainLinkMode(env)
  if (mode === 'relay-probe') return await runProbeMode(env)
  if (mode === 'bootstrap-env') return await runBootstrapEnvMode(env)
  throw new Error(`Unsupported ALEPH_VM_MODE "${mode}" in Aleph site runner.`)
}
