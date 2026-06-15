import process from "node:process"
import { createHash } from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"

import { broadcastAlephMessage, forgetAlephMessages, normalizeBroadcastStatus, publishAggregateKey, signAlephMessage } from "../../core/src/index.ts"
import { inspectMessageResult } from "../../core/src/deployment-inspection.ts"

import { optionalEnv, requiredEnv } from "./env.ts"
import { appendGithubOutput, appendGithubSummary } from "./github-outputs.ts"
import type { RelayProbeResult } from "./relay-probe.ts"
import { createPrivateKeyIdentity } from "./signer.ts"

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'
const DAG_PB_CODEC = 0x70

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

async function waitForAlephMessage(itemHash: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const apiHost = optionalEnv('ALEPH_SITE_ALEPH_API_HOST', 'https://api.aleph.im', env)
  const attempts = Number(optionalEnv('ALEPH_SITE_ALEPH_MESSAGE_WAIT_ATTEMPTS', '60', env))
  const delayMs = Number(optionalEnv('ALEPH_SITE_ALEPH_MESSAGE_WAIT_DELAY_MS', '5000', env))

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await inspectMessageResult(itemHash, {
      apiHost,
      fetch: fetch,
      label: 'Aleph STORE message',
    })
    if (result.status === 'processed') return
    if (result.status === 'rejected') {
      throw new Error(result.rejectionReason ?? `Aleph STORE message ${itemHash} was rejected.`)
    }
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }

  throw new Error(`Aleph STORE message ${itemHash} did not become processed in time.`)
}

interface SitePublishResult {
  cidV0: string
  cidV1: string
}

interface AlephStoreContent {
  address: string
  time: number
  item_type: 'ipfs'
  item_hash: string
  ref?: string
}

interface DomainAggregateEntry {
  message_id: string
  type: 'ipfs'
  programType: 'ipfs'
  options?: {
    catch_all_path: string
  } | null
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
    const payload = JSON.parse(trimmed) as { Hash?: string }
    cidV0 = payload.Hash ?? cidV0
  }
  if (!cidV0) {
    throw new Error('CID not found in IPFS response')
  }

  return {
    cidV0,
    cidV1: cidV0ToV1(cidV0),
  }
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
  const apiHost = optionalEnv('ALEPH_SITE_ALEPH_API_HOST', 'https://api.aleph.im', env)
  const channel = optionalEnv('ALEPH_SITE_CHANNEL', 'TEST', env)
  const identity = await createPrivateKeyIdentity(privateKey)
  const records = await fetchScopedSiteStoreRecords({
    sender: identity.address,
    ref,
    apiHost,
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
    apiHost,
    sync: true,
  })

  if (result.status === 'rejected') {
    throw new Error(`Aleph site retention forget was rejected: ${JSON.stringify(result.response ?? {})}`)
  }
}

async function pinIpfsCidOnAleph(cidV0: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const privateKey = requiredEnv('ALEPH_PRIVATE_KEY', env)
  const channel = optionalEnv('ALEPH_SITE_CHANNEL', 'TEST', env)
  const apiHost = optionalEnv('ALEPH_SITE_ALEPH_API_HOST', 'https://api.aleph.im', env)
  const ref = optionalEnv('ALEPH_SITE_REF', '', env).trim() || undefined
  const identity = await createPrivateKeyIdentity(privateKey)
  const now = Date.now() / 1000
  const content: AlephStoreContent = {
    address: identity.address,
    time: now,
    item_type: 'ipfs',
    item_hash: cidV0,
    ...(ref ? { ref } : {}),
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
  const message = await signAlephMessage(unsignedMessage, identity.signer)
  const { response, httpStatus } = await broadcastAlephMessage(message, {
    apiHost,
    sync: true,
    fetch,
  })
  const status = normalizeBroadcastStatus(httpStatus, response?.message_status)
  if (status === 'rejected') {
    throw new Error(`Aleph STORE pin was rejected: ${JSON.stringify(response?.details ?? response ?? {})}`)
  }
  const itemHash = typeof response?.item_hash === 'string' ? response.item_hash : message.item_hash
  if (!itemHash) {
    throw new Error(`Aleph pin response did not include item_hash: ${JSON.stringify(response ?? {})}`)
  }
  return itemHash
}

export async function runSitePublishMode(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const projectDir = optionalEnv('ALEPH_SITE_PROJECT_DIR', process.cwd(), env)
  const siteDirectoryInput = requiredEnv('ALEPH_SITE_DIRECTORY', env)
  const siteDirectory = isAbsolute(siteDirectoryInput)
    ? siteDirectoryInput
    : resolve(projectDir, siteDirectoryInput)
  const ipfsGateway = optionalEnv('ALEPH_SITE_IPFS_GATEWAY', 'https://ipfs-2.aleph.im', env)
  const pin = optionalEnv('ALEPH_SITE_PIN', 'true', env) === 'true'

  const publish = await uploadStaticSiteDirectory(siteDirectory, ipfsGateway)
  const cidV0 = publish.cidV0
  const cidV1 = publish.cidV1

  await appendGithubOutput('ipfs_cid_v0', cidV0, env)
  await appendGithubOutput('ipfs_cid_v1', cidV1, env)
  await appendGithubOutput('url', `https://${cidV1}.ipfs.aleph.sh`, env)

  let itemHash = ''
  if (pin) {
    itemHash = await pinIpfsCidOnAleph(cidV0, env)
    await appendGithubOutput('item_hash', itemHash, env)
    await waitForAlephMessage(itemHash, env)
    await retainRecentSiteStores({ currentItemHash: itemHash, env })
  }

  await appendGithubSummary([
    '## Aleph Site Runner',
    '',
    `- Site directory: \`${siteDirectory}\``,
    `- IPFS CID v0: \`${cidV0}\``,
    `- IPFS CID v1: \`${cidV1}\``,
    `- Aleph item hash: \`${itemHash}\``,
  ], env)
}

export async function runDomainLinkMode(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const privateKey = requiredEnv('ALEPH_PRIVATE_KEY', env)
  const domain = requiredEnv('ALEPH_SITE_DOMAIN', env)
  const itemHash = requiredEnv('ALEPH_SITE_ITEM_HASH', env)
  const catchAllPath = optionalEnv('ALEPH_SITE_DOMAIN_CATCH_ALL_PATH', '/index.html', env)
  const apiHost = optionalEnv('ALEPH_SITE_ALEPH_API_HOST', 'https://api.aleph.im', env)
  const identity = await createPrivateKeyIdentity(privateKey)

  const detachPublication = await publishAggregateKey({
    sender: identity.address,
    key: 'domains',
    content: { [domain]: null },
    signer: identity.signer,
    hasher: async (payload) => defaultHasher(payload),
    fetch,
    channel: 'ALEPH-CLOUDSOLUTIONS',
    apiHost,
  })
  if (detachPublication.status === 'rejected') {
    throw new Error(`Aleph domain detach ${domain} was rejected: ${JSON.stringify(detachPublication.response ?? {})}`)
  }

  const attachEntry: DomainAggregateEntry = {
    message_id: itemHash,
    type: 'ipfs',
    programType: 'ipfs',
    options: catchAllPath.startsWith('/') ? { catch_all_path: catchAllPath } : null,
  }
  const attachPublication = await publishAggregateKey({
    sender: identity.address,
    key: 'domains',
    content: { [domain]: attachEntry },
    signer: identity.signer,
    hasher: async (payload) => defaultHasher(payload),
    fetch,
    channel: 'ALEPH-CLOUDSOLUTIONS',
    apiHost,
  })
  if (attachPublication.status === 'rejected') {
    throw new Error(`Aleph domain attach ${domain} was rejected: ${JSON.stringify(attachPublication.response ?? {})}`)
  }

  await appendGithubOutput('domain', domain, env)
  await appendGithubOutput('item_hash', itemHash, env)
  await appendGithubOutput('url', `https://${domain}`, env)
  await appendGithubOutput('domain_message_hash', attachPublication.itemHash, env)

  await appendGithubSummary([
    '## Aleph Site Runner',
    '',
    `- Linked domain: \`${domain}\``,
    `- Aleph item hash: \`${itemHash}\``,
    `- Domain aggregate hash: \`${attachPublication.itemHash}\``,
    `- Catch-all path: \`${catchAllPath}\``,
  ], env)
}

export async function runProbeMode(
  env: NodeJS.ProcessEnv = process.env,
  options: { probe?: (addrs: string[], env: NodeJS.ProcessEnv) => Promise<RelayProbeResult[]> } = {}
): Promise<void> {
  const addrs = mergedAddrs(env)
  if (addrs.length === 0) throw new Error('No relay probe or browser bootstrap multiaddrs were supplied.')
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
