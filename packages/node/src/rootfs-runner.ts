import { pathToFileURL } from "node:url";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { Agent } from "undici";
import { bitswap } from "@helia/block-brokers";
import { libp2pRouting } from "@helia/routers";
import { unixfs } from "@helia/unixfs";
import { Helia } from "@helia/utils";
import { bootstrap } from "@le-space/libp2p-bootstrap";
import { noise } from "@le-space/libp2p-noise";
import { identify } from "@le-space/libp2p-identify";
import { kadDHT } from "@le-space/libp2p-kad-dht";
import { ping } from "@le-space/libp2p-ping";
import { tcp } from "@le-space/libp2p-tcp";
import { yamux } from "@le-space/libp2p-yamux";
import { webSockets } from "@le-space/libp2p-websockets";
import { multiaddr } from "@multiformats/multiaddr";
import { MemoryBlockstore } from "blockstore-core";
import { MemoryDatastore } from "datastore-core";
import { createLibp2p as createHeliaLibp2p } from "libp2p-helia";

import {
  buildRootfs,
  createRootfsBuildPlan,
  finalizeRootfsBuildPipeline,
  publicationArtifacts,
  readRootfsContractFile,
  type RootfsBuildPlan,
  type RootfsPublishExecutionResult,
  type RootfsToolchainAvailability,
} from "../../rootfs/src/index.ts";
import { broadcastAlephMessage, normalizeBroadcastStatus, signAlephMessage } from "../../core/src/index.ts";
import { inspectMessageResult, isTransientMessageLookupError } from "../../core/src/deployment-inspection.ts";

import { booleanEnv, optionalEnv, requiredEnv } from "./env.ts";
import { appendGithubOutput, appendGithubSummary } from "./github-outputs.ts";
import { createPrivateKeyIdentity } from "./signer.ts";

export interface ParsedRootfsRunnerInputs {
  buildPlan: RootfsBuildPlan;
  availability: RootfsToolchainAvailability;
  referenceRootfsDir?: string;
  createdAt?: string;
}

interface RootfsIpfsUploadResult {
  cid: string;
  responseText: string;
  sourceSizeBytes?: number;
  cleanup?: () => Promise<void>;
}

type RootfsUploadDriver = 'ipfs-add' | 'aleph-api-ipfs' | 'helia' | 'api-fetch' | 'api-curl'

interface RootfsUploadRuntimeOptions {
  driver: RootfsUploadDriver;
  headersTimeoutMs: number;
  bodyTimeoutMs: number;
  connectTimeoutMs: number;
  heliaProvideTimeoutMs: number;
  heliaBootstrapDialTimeoutMs: number;
  heliaProviderKeepaliveSeconds: number;
  heliaBootstrapMultiaddrs: string[];
}

type RootfsHeliaNode = Helia<any>

class TerminalAlephStorePublishError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TerminalAlephStorePublishError'
  }
}

class PendingAlephStorePublishError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PendingAlephStorePublishError'
  }
}

const DEFAULT_IPFS_BOOTSTRAP_MULTIADDRS = [
  '/ip4/46.255.204.209/tcp/4001/p2p/12D3KooWHWNCn8t9NKQPBPZU61Fq6BoVw9XV37YsWTuMLwZXrEtj',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt',
  '/dnsaddr/va1.bootstrap.libp2p.io/p2p/12D3KooWKnDdG3iXw9eTFijk3EWSunZcFi54Zka4wmtqtt6rPxc8',
  '/ip4/104.131.131.82/tcp/4001/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ',
]

function uniqueNonEmptyValues(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const normalized = value.trim()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

function parseRootfsAlephApiHosts(
  buildPlan: RootfsBuildPlan,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const rawHosts =
    optionalEnv('ALEPH_ROOTFS_ALEPH_API_HOSTS', '', env).trim() ||
    optionalEnv('ALEPH_VM_API_HOSTS', '', env).trim()
  if (!rawHosts) return [buildPlan.alephApiHost]

  const hosts = uniqueNonEmptyValues(rawHosts.split(/[\s,]+/u))
  if (hosts.length === 0) {
    throw new Error('ALEPH_ROOTFS_ALEPH_API_HOSTS did not contain any API host URLs.')
  }
  return hosts
}

function parseRootfsIpfsAddUrls(
  buildPlan: RootfsBuildPlan,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const rawUrls =
    optionalEnv('ALEPH_ROOTFS_IPFS_ADD_URLS', '', env).trim() ||
    optionalEnv('ALEPH_ROOTFS_IPFS_ADD_URL', '', env).trim()
  if (!rawUrls) return [buildPlan.ipfsAddUrl]

  const urls = uniqueNonEmptyValues(rawUrls.split(/[\s,]+/u))
  if (urls.length === 0) {
    throw new Error('ALEPH_ROOTFS_IPFS_ADD_URLS did not contain any IPFS add endpoint URLs.')
  }
  return urls
}

function parseRootfsIpfsGatewayUrls(
  buildPlan: RootfsBuildPlan,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const rawUrls =
    optionalEnv('ALEPH_ROOTFS_IPFS_GATEWAY_URLS', '', env).trim() ||
    optionalEnv('ALEPH_ROOTFS_IPFS_GATEWAY_URL', '', env).trim()
  if (!rawUrls) return [buildPlan.ipfsGatewayUrl]

  const urls = uniqueNonEmptyValues(rawUrls.split(/[\s,]+/u))
  if (urls.length === 0) {
    throw new Error('ALEPH_ROOTFS_IPFS_GATEWAY_URLS did not contain any IPFS gateway URLs.')
  }
  return urls
}

async function commandExists(command: string, pathValue: string): Promise<boolean> {
  for (const segment of pathValue.split(path.delimiter)) {
    const candidate = segment ? path.join(segment, command) : command
    try {
      await access(candidate)
      return true
    } catch {
      continue
    }
  }
  return false
}

async function commandRunsSuccessfully(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: 'ignore',
    })
    child.on('error', () => resolve(false))
    child.on('exit', (code) => resolve(code === 0))
  })
}

async function detectRootfsToolchainAvailability(env: NodeJS.ProcessEnv): Promise<RootfsToolchainAvailability> {
  const pathValue = env.PATH ?? process.env.PATH ?? ''
  const envHasDocker = env.ALEPH_ROOTFS_HAS_DOCKER
  const envDockerDaemonRunning = env.ALEPH_ROOTFS_DOCKER_DAEMON_RUNNING
  const envHasVirtCustomize = env.ALEPH_ROOTFS_HAS_VIRT_CUSTOMIZE

  const hasDocker =
    envHasDocker == null
      ? await commandExists('docker', pathValue)
      : booleanEnv('ALEPH_ROOTFS_HAS_DOCKER', false, env)

  const dockerDaemonRunning =
    envDockerDaemonRunning == null
      ? (hasDocker ? await commandRunsSuccessfully('docker', ['info'], env) : undefined)
      : booleanEnv('ALEPH_ROOTFS_DOCKER_DAEMON_RUNNING', false, env)

  const hasVirtCustomize =
    envHasVirtCustomize == null
      ? await commandExists('virt-customize', pathValue)
      : booleanEnv('ALEPH_ROOTFS_HAS_VIRT_CUSTOMIZE', false, env)

  return {
    githubActions: env.GITHUB_ACTIONS === 'true',
    hasDocker,
    dockerDaemonRunning,
    hasVirtCustomize,
  }
}

async function deriveOrbitdbRelayVersion(
  sourceDir: string,
  profileId: 'orbitdb-relay',
): Promise<string | undefined> {
  const packageJsonPath = path.join(sourceDir, 'package.json')
  try {
    const payload = JSON.parse(await readFile(packageJsonPath, 'utf8')) as { version?: unknown }
    if (typeof payload.version === 'string' && payload.version.trim()) {
      return `${profileId}-v${payload.version.trim().replace(/^v/u, '')}`
    }
  } catch {
    return undefined
  }

  return undefined
}

export async function parseRootfsRunnerInputs(env: NodeJS.ProcessEnv = process.env): Promise<ParsedRootfsRunnerInputs> {
  const contractPath = requiredEnv('ALEPH_ROOTFS_CONTRACT_PATH', env);
  const contract = await readRootfsContractFile(contractPath);
  const orbitdbRelayDir = optionalEnv('ALEPH_ROOTFS_ORBITDB_RELAY_DIR', undefined, env) || undefined
  const explicitRootfsVersion = optionalEnv('ALEPH_ROOTFS_VERSION', undefined, env) || undefined
  const derivedOrbitdbVersion =
    !explicitRootfsVersion &&
    contract.id === 'orbitdb-relay' &&
    orbitdbRelayDir
      ? await deriveOrbitdbRelayVersion(
          orbitdbRelayDir,
          contract.id,
        )
      : undefined
  const buildPlan = createRootfsBuildPlan(contract, {
    projectDir: requiredEnv('ALEPH_ROOTFS_PROJECT_DIR', env),
    orbitdbRelayDir,
    contractPath,
    alephDir: optionalEnv('ALEPH_ROOTFS_ALEPH_DIR', undefined, env) || undefined,
    outDir: optionalEnv('ALEPH_ROOTFS_OUT_DIR', undefined, env) || undefined,
    driver: (optionalEnv('ALEPH_ROOTFS_DRIVER', 'auto', env) as 'auto' | 'host' | 'docker'),
    rootfsVersion: explicitRootfsVersion ?? derivedOrbitdbVersion,
    rootfsSizeMiB: Number(optionalEnv('ALEPH_ROOTFS_SIZE_MIB', '', env)) || undefined,
    rootfsImageSize: optionalEnv('ALEPH_ROOTFS_IMAGE_SIZE', undefined, env) || undefined,
    channel: optionalEnv('ALEPH_ROOTFS_CHANNEL', undefined, env) || undefined,
    skipUpload: booleanEnv('ALEPH_ROOTFS_SKIP_UPLOAD', false, env),
    skipBuild: booleanEnv('ALEPH_ROOTFS_SKIP_BUILD', false, env),
    ipfsAddUrl: optionalEnv('ALEPH_ROOTFS_IPFS_ADD_URL', undefined, env) || undefined,
    ipfsGatewayUrl: optionalEnv('ALEPH_ROOTFS_IPFS_GATEWAY_URL', undefined, env) || undefined,
    alephApiHost: optionalEnv('ALEPH_ROOTFS_ALEPH_API_HOST', undefined, env) || undefined,
    alephMessageWaitAttempts: Number(optionalEnv('ALEPH_ROOTFS_ALEPH_MESSAGE_WAIT_ATTEMPTS', '', env)) || undefined,
    alephMessageWaitDelaySeconds: Number(optionalEnv('ALEPH_ROOTFS_ALEPH_MESSAGE_WAIT_DELAY_SECONDS', '', env)) || undefined,
    alephPinAttempts: Number(optionalEnv('ALEPH_ROOTFS_ALEPH_PIN_ATTEMPTS', '', env)) || undefined,
    alephPinDelaySeconds: Number(optionalEnv('ALEPH_ROOTFS_ALEPH_PIN_DELAY_SECONDS', '', env)) || undefined,
    ipfsGatewayWaitAttempts: Number(optionalEnv('ALEPH_ROOTFS_IPFS_GATEWAY_WAIT_ATTEMPTS', '', env)) || undefined,
    ipfsGatewayWaitDelaySeconds: Number(optionalEnv('ALEPH_ROOTFS_IPFS_GATEWAY_WAIT_DELAY_SECONDS', '', env)) || undefined,
  });

  return {
    buildPlan,
    availability: await detectRootfsToolchainAvailability(env),
    referenceRootfsDir: optionalEnv('ALEPH_ROOTFS_REFERENCE_ROOTFS_DIR', undefined, env) || undefined,
    createdAt: optionalEnv('ALEPH_ROOTFS_CREATED_AT', undefined, env) || undefined,
  };
}

export async function runLocalCommand(command: {
  command: string;
  args: string[];
  workdir?: string;
  env?: Record<string, string>;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.command, command.args, {
      cwd: command.workdir,
      env: { ...process.env, ...command.env },
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command.command} ${command.args.join(' ')} failed with exit code ${code ?? 'unknown'}`));
      }
    });
  });
}

async function sha256Hex(payload: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload))
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function positiveTimeoutMs(value: string | undefined, fallback: number): number {
  const normalized = (value ?? '').trim()
  if (!normalized) return fallback
  const parsed = Number(normalized)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function nonNegativeInteger(value: string | undefined, fallback: number): number {
  const normalized = (value ?? '').trim()
  if (!normalized) return fallback
  const parsed = Number(normalized)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback
}

function timeoutSeconds(valueMs: number): string {
  return String(Math.max(1, Math.ceil(valueMs / 1000)))
}

function parseMultiaddrList(value: string | undefined): string[] {
  return uniqueNonEmptyValues((value ?? '').split(/[\s,]+/u))
}

function parseRootfsUploadDriver(value: string | undefined): RootfsUploadDriver {
  const normalized = (value ?? 'aleph-ipfs').trim().toLowerCase()
  switch (normalized) {
    case '':
    case 'aleph-ipfs':
    case 'ipfs':
    case 'ipfs-add':
      return 'ipfs-add'
    case 'aleph-api-ipfs':
    case 'add-file':
      return 'aleph-api-ipfs'
    case 'helia':
      return 'helia'
    case 'api-fetch':
    case 'fetch':
      return 'api-fetch'
    case 'api-curl':
    case 'curl':
      return 'api-curl'
    default:
      throw new Error(
        `Unsupported ALEPH_ROOTFS_UPLOAD_DRIVER "${normalized}". Expected "aleph-ipfs", "aleph-api-ipfs", "helia", "api-fetch", or "api-curl".`,
      )
  }
}

function rootfsStorePaymentType(env: NodeJS.ProcessEnv = process.env): 'credit' | 'hold' {
  const normalized = optionalEnv('ALEPH_ROOTFS_STORE_PAYMENT_TYPE', 'credit', env).trim().toLowerCase()
  if (normalized === 'credit' || normalized === 'credits') return 'credit'
  if (normalized === 'hold') return 'hold'
  throw new Error(`Unsupported ALEPH_ROOTFS_STORE_PAYMENT_TYPE "${normalized}". Expected "credit" or "hold".`)
}

function rootfsRequireProcessedStore(env: NodeJS.ProcessEnv = process.env): boolean {
  return booleanEnv('ALEPH_ROOTFS_REQUIRE_PROCESSED_STORE', false, env)
}

function rootfsUploadRuntimeOptions(env: NodeJS.ProcessEnv = process.env): RootfsUploadRuntimeOptions {
  return {
    driver: parseRootfsUploadDriver(env.ALEPH_ROOTFS_UPLOAD_DRIVER),
    headersTimeoutMs: positiveTimeoutMs(env.ALEPH_ROOTFS_UPLOAD_HEADERS_TIMEOUT_MS, 15 * 60 * 1000),
    bodyTimeoutMs: positiveTimeoutMs(env.ALEPH_ROOTFS_UPLOAD_BODY_TIMEOUT_MS, 15 * 60 * 1000),
    connectTimeoutMs: positiveTimeoutMs(env.ALEPH_ROOTFS_UPLOAD_CONNECT_TIMEOUT_MS, 30 * 1000),
    heliaProvideTimeoutMs: positiveTimeoutMs(env.ALEPH_ROOTFS_HELIA_PROVIDE_TIMEOUT_MS, 2 * 60 * 1000),
    heliaBootstrapDialTimeoutMs: positiveTimeoutMs(env.ALEPH_ROOTFS_HELIA_BOOTSTRAP_DIAL_TIMEOUT_MS, 30 * 1000),
    heliaProviderKeepaliveSeconds: nonNegativeInteger(env.ALEPH_ROOTFS_HELIA_PROVIDER_KEEPALIVE_SECONDS, 60),
    heliaBootstrapMultiaddrs: parseMultiaddrList(
      env.ALEPH_ROOTFS_HELIA_BOOTSTRAP_MULTIADDRS ??
      env.ALEPH_ROOTFS_IPFS_BOOTSTRAP_MULTIADDRS,
    ),
  }
}

function describeUploadError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error)
  }

  const details = [
    `${error.name}: ${error.message}`,
  ]
  if (error.cause !== undefined) {
    if (error.cause instanceof Error) {
      details.push(`cause=${error.cause.name}: ${error.cause.message}`)
    } else {
      details.push(`cause=${String(error.cause)}`)
    }
  }
  return details.join('; ')
}

async function sleep(seconds: number): Promise<void> {
  if (seconds <= 0) return
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
}

async function createRootfsHeliaNode(extraBootstrapMultiaddrs: readonly string[]): Promise<RootfsHeliaNode> {
  const datastore = new MemoryDatastore() as any
  const blockstore = new MemoryBlockstore() as any
  const bootstrapMultiaddrs = uniqueNonEmptyValues([
    ...DEFAULT_IPFS_BOOTSTRAP_MULTIADDRS,
    ...extraBootstrapMultiaddrs,
  ])
  const libp2p = await createHeliaLibp2p({
    addresses: {
      listen: [
        '/ip4/0.0.0.0/tcp/0',
        '/ip4/0.0.0.0/tcp/0/ws',
      ],
    },
    datastore,
    peerDiscovery: [
      bootstrap({
        list: bootstrapMultiaddrs,
      }),
    ],
    transports: [
      tcp(),
      webSockets(),
    ],
    connectionEncrypters: [
      noise(),
    ],
    streamMuxers: [
      yamux(),
    ],
    connectionGater: {
      denyDialMultiaddr: async () => false,
    },
    services: {
      dht: kadDHT({
        protocol: '/ipfs/kad/1.0.0',
      }),
      identify: identify(),
      ping: ping(),
    },
    start: false,
  })
  const helia = new Helia({
    libp2p,
    datastore,
    blockstore,
    blockBrokers: [
      bitswap(),
    ],
    routers: [
      libp2pRouting(libp2p),
    ],
  }) as RootfsHeliaNode
  await helia.start()
  console.warn(
    `Helia rootfs provider ${helia.libp2p.peerId.toString()} started with ${bootstrapMultiaddrs.length} bootstrap peers.`,
  )
  return helia
}

async function dialConfiguredHeliaBootstrapPeers(
  helia: RootfsHeliaNode,
  multiaddrs: readonly string[],
  timeoutMs: number,
): Promise<void> {
  const attempts = multiaddrs.map(async (value) => {
    const address = multiaddr(value)
    await helia.libp2p.dial(address as any, {
      signal: AbortSignal.timeout(timeoutMs),
    })
  })
  const results = await Promise.allSettled(attempts)
  for (const [index, result] of results.entries()) {
    if (result.status === 'rejected') {
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason)
      console.warn(`Helia bootstrap peer dial failed for ${multiaddrs[index]}: ${reason}`)
    }
  }
}

async function pinHeliaCid(helia: RootfsHeliaNode, cid: Parameters<RootfsHeliaNode['pins']['add']>[0]): Promise<void> {
  for await (const pinnedCid of helia.pins.add(cid, {
    metadata: {
      source: 'relay-button-rootfs',
    },
  })) {
    console.warn(`Helia pinned rootfs block ${pinnedCid.toString()}`)
  }
}

async function uploadRootfsImageToIpfsWithHelia(
  buildPlan: RootfsBuildPlan,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RootfsIpfsUploadResult> {
  const runtime = rootfsUploadRuntimeOptions(env)
  const helia = await createRootfsHeliaNode(runtime.heliaBootstrapMultiaddrs)
  let stopped = false
  const stopHelia = async () => {
    if (stopped) return
    stopped = true
    await helia.stop()
  }

  try {
    if (runtime.heliaBootstrapMultiaddrs.length > 0) {
      await dialConfiguredHeliaBootstrapPeers(
        helia,
        runtime.heliaBootstrapMultiaddrs,
        runtime.heliaBootstrapDialTimeoutMs,
      )
    }

    const fs = unixfs(helia)
    const sourceSizeBytes = (await stat(buildPlan.imagePath)).size
    const cid = await fs.addByteStream(createReadStream(buildPlan.imagePath), {
      cidVersion: 1,
      rawLeaves: true,
    })
    await pinHeliaCid(helia, cid)
    await helia.routing.provide(cid, {
      signal: AbortSignal.timeout(runtime.heliaProvideTimeoutMs),
    })

    const responseText = JSON.stringify({
      Name: path.basename(buildPlan.imagePath),
      Hash: cid.toString(),
      Size: String(sourceSizeBytes),
      Provider: 'helia',
    })

    return {
      cid: cid.toString(),
      responseText,
      sourceSizeBytes,
      cleanup: async () => {
        await sleep(runtime.heliaProviderKeepaliveSeconds)
        await stopHelia()
      },
    }
  } catch (error) {
    await stopHelia()
    throw new Error(
      `IPFS publication via Helia failed for ${buildPlan.imagePath}; provideTimeoutMs=${runtime.heliaProvideTimeoutMs}; bootstrapDialTimeoutMs=${runtime.heliaBootstrapDialTimeoutMs}; ${describeUploadError(error)}`,
      { cause: error },
    )
  }
}

async function uploadRootfsImageToIpfsWithFetch(
  buildPlan: RootfsBuildPlan,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RootfsIpfsUploadResult> {
  const runtime = rootfsUploadRuntimeOptions(env)
  const dispatcher = new Agent({
    connect: {
      timeout: runtime.connectTimeoutMs,
    },
    headersTimeout: runtime.headersTimeoutMs,
    bodyTimeout: runtime.bodyTimeoutMs,
  })

  try {
    const bytes = await readFile(buildPlan.imagePath)
    const file = new File([bytes], path.basename(buildPlan.imagePath))
    const formData = new FormData()
    formData.append('file', file)

    const response = await fetch(
      buildPlan.ipfsAddUrl,
      {
        method: 'POST',
        body: formData,
        dispatcher,
      } as RequestInit & { dispatcher: Agent },
    )
    if (!response.ok) {
      throw new Error(`IPFS upload failed with ${response.status} ${response.statusText}`)
    }

    const responseText = await response.text()
    const lines = responseText.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)
    if (lines.length === 0) {
      throw new Error('No response received from the IPFS add endpoint')
    }

    const payload = JSON.parse(lines.at(-1) ?? '{}') as { Hash?: string; Size?: string | number }
    const cid = payload.Hash?.trim()
    if (!cid) {
      throw new Error(`IPFS add response did not include a Hash: ${JSON.stringify(payload)}`)
    }

    let sourceSizeBytes: number | undefined
    if (typeof payload.Size === 'number' && Number.isFinite(payload.Size) && payload.Size > 0) {
      sourceSizeBytes = payload.Size
    } else if (typeof payload.Size === 'string' && /^\d+$/u.test(payload.Size)) {
      sourceSizeBytes = Number(payload.Size)
    }

    return { cid, responseText, sourceSizeBytes }
  } catch (error) {
    throw new Error(
      `IPFS upload via fetch failed for ${buildPlan.imagePath} -> ${buildPlan.ipfsAddUrl}; headersTimeoutMs=${runtime.headersTimeoutMs}; bodyTimeoutMs=${runtime.bodyTimeoutMs}; connectTimeoutMs=${runtime.connectTimeoutMs}; ${describeUploadError(error)}`,
      { cause: error },
    )
  } finally {
    await dispatcher.close()
  }
}

async function uploadRootfsImageToIpfsWithAlephApi(
  buildPlan: RootfsBuildPlan,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RootfsIpfsUploadResult> {
  const apiHosts = parseRootfsAlephApiHosts(buildPlan, env)
  let lastError: unknown = null

  for (const [index, apiHost] of apiHosts.entries()) {
    const endpoint = `${apiHost.replace(/\/+$/u, '')}/api/v0/ipfs/add_file`
    try {
      if (apiHosts.length > 1) {
        console.warn(`Aleph rootfs IPFS upload API host attempt ${index + 1}/${apiHosts.length}: ${apiHost}`)
      }
      const responseText = await new Promise<string>((resolve, reject) => {
        const curl = spawn(
          'curl',
          [
            '--fail',
            '--silent',
            '--show-error',
            '-X',
            'POST',
            '-F',
            `file=@${buildPlan.imagePath};type=application/octet-stream`,
            endpoint,
          ],
          { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } },
        )

        let stdout = ''
        let stderr = ''
        curl.stdout.on('data', (chunk) => {
          stdout += chunk.toString()
        })
        curl.stderr.on('data', (chunk) => {
          stderr += chunk.toString()
        })
        curl.on('error', (error) => {
          reject(error)
        })
        curl.on('close', (code) => {
          if (code === 0) {
            resolve(stdout)
            return
          }

          const details = stderr.trim()
          reject(new Error(details ? `Aleph IPFS upload failed: ${details}` : `curl failed with exit code ${code ?? 'unknown'}`))
        })
      })

      const payload = JSON.parse(responseText.trim() || '{}') as {
        Hash?: string;
        hash?: string;
        Size?: string | number;
        size?: string | number;
      }
      const cid = (payload.Hash ?? payload.hash)?.trim()
      if (!cid) {
        throw new Error(`Aleph IPFS upload response did not include a hash: ${JSON.stringify(payload)}`)
      }

      const size = payload.Size ?? payload.size
      let sourceSizeBytes: number | undefined
      if (typeof size === 'number' && Number.isFinite(size) && size > 0) {
        sourceSizeBytes = size
      } else if (typeof size === 'string' && /^\d+$/u.test(size)) {
        sourceSizeBytes = Number(size)
      }

      const normalizedResponseText = JSON.stringify({
        ...payload,
        Hash: cid,
        Size: sourceSizeBytes !== undefined ? String(sourceSizeBytes) : undefined,
      })

      return { cid, responseText: normalizedResponseText, sourceSizeBytes }
    } catch (error) {
      lastError = error
      if (index < apiHosts.length - 1) {
        const message = error instanceof Error ? error.message : String(error)
        console.warn(
          `Aleph rootfs IPFS upload API host ${apiHost} failed; retrying with ${apiHosts[index + 1]}. ${message}`,
        )
      }
    }
  }

  const suffix = lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error(
    `Aleph rootfs IPFS upload failed through all configured API hosts (${apiHosts.join(', ')}). Last error: ${suffix}`,
  )
}

async function uploadRootfsImageToIpfsWithCurl(
  buildPlan: RootfsBuildPlan,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RootfsIpfsUploadResult> {
  const runtime = rootfsUploadRuntimeOptions(env)
  const ipfsAddUrls = parseRootfsIpfsAddUrls(buildPlan, env)
  let lastError: unknown = null

  for (const [index, ipfsAddUrl] of ipfsAddUrls.entries()) {
    try {
      if (ipfsAddUrls.length > 1) {
        console.warn(`IPFS rootfs add endpoint attempt ${index + 1}/${ipfsAddUrls.length}: ${ipfsAddUrl}`)
      }
      const responseText = await new Promise<string>((resolve, reject) => {
        const curl = spawn(
          'curl',
          [
            '--fail',
            '--silent',
            '--show-error',
            '--connect-timeout',
            timeoutSeconds(runtime.connectTimeoutMs),
            '--max-time',
            timeoutSeconds(runtime.bodyTimeoutMs),
            '-X',
            'POST',
            '-F',
            `file=@${buildPlan.imagePath};type=application/octet-stream`,
            ipfsAddUrl,
          ],
          { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } },
        )

        let stdout = ''
        let stderr = ''
        curl.stdout.on('data', (chunk) => {
          stdout += chunk.toString()
        })
        curl.stderr.on('data', (chunk) => {
          stderr += chunk.toString()
        })
        curl.on('error', (error) => {
          reject(error)
        })
        curl.on('close', (code) => {
          if (code === 0) {
            resolve(stdout)
            return
          }

          const details = stderr.trim()
          reject(new Error(details ? `IPFS upload failed: ${details}` : `curl failed with exit code ${code ?? 'unknown'}`))
        })
      })

      const lines = responseText.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)
      if (lines.length === 0) {
        throw new Error('No response received from the IPFS add endpoint')
      }

      const payload = JSON.parse(lines.at(-1) ?? '{}') as { Hash?: string; Size?: string | number }
      const cid = payload.Hash?.trim()
      if (!cid) {
        throw new Error(`IPFS add response did not include a Hash: ${JSON.stringify(payload)}`)
      }

      let sourceSizeBytes: number | undefined
      if (typeof payload.Size === 'number' && Number.isFinite(payload.Size) && payload.Size > 0) {
        sourceSizeBytes = payload.Size
      } else if (typeof payload.Size === 'string' && /^\d+$/u.test(payload.Size)) {
        sourceSizeBytes = Number(payload.Size)
      }

      return { cid, responseText, sourceSizeBytes }
    } catch (error) {
      lastError = error
      if (index < ipfsAddUrls.length - 1) {
        const message = error instanceof Error ? error.message : String(error)
        console.warn(`IPFS rootfs add endpoint ${ipfsAddUrl} failed; retrying with ${ipfsAddUrls[index + 1]}. ${message}`)
      }
    }
  }

  const suffix = lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error(
    `IPFS rootfs upload failed through all configured add endpoints (${ipfsAddUrls.join(', ')}). Last error: ${suffix}`,
  )
}

async function uploadRootfsImageToIpfs(
  buildPlan: RootfsBuildPlan,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RootfsIpfsUploadResult> {
  const runtime = rootfsUploadRuntimeOptions(env)
  switch (runtime.driver) {
    case 'ipfs-add':
      return uploadRootfsImageToIpfsWithCurl(buildPlan, env)
    case 'aleph-api-ipfs':
      return uploadRootfsImageToIpfsWithAlephApi(buildPlan, env)
    case 'helia':
      return uploadRootfsImageToIpfsWithHelia(buildPlan, env)
    case 'api-fetch':
      return uploadRootfsImageToIpfsWithFetch(buildPlan, env)
    case 'api-curl':
      return uploadRootfsImageToIpfsWithCurl(buildPlan, env)
  }
}

async function waitForIpfsCidAvailable(
  buildPlan: RootfsBuildPlan,
  cid: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const gatewayBaseUrls = parseRootfsIpfsGatewayUrls(buildPlan, env)
  for (let attempt = 1; attempt <= buildPlan.ipfsGatewayWaitAttempts; attempt += 1) {
    for (const gatewayBaseUrl of gatewayBaseUrls) {
      const gatewayUrl = `${gatewayBaseUrl.replace(/\/+$/u, '')}/${cid}`
      try {
        const response = await fetch(gatewayUrl, {
          method: 'GET',
          headers: { range: 'bytes=0-0' },
        })
        if (response.status === 200 || response.status === 206) {
          return
        }
      } catch {
        // retry below
      }
    }

    if (attempt < buildPlan.ipfsGatewayWaitAttempts) {
      await new Promise((resolve) => setTimeout(resolve, buildPlan.ipfsGatewayWaitDelaySeconds * 1000))
    }
  }

  throw new Error(`CID ${cid} did not become retrievable from ${gatewayBaseUrls.join(', ')} after ${buildPlan.ipfsGatewayWaitAttempts} attempts.`)
}

async function pinRootfsCidOnAleph(
  buildPlan: RootfsBuildPlan,
  cid: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ itemHash: string; apiHost: string }> {
  const privateKey = requiredEnv('ALEPH_PRIVATE_KEY', env)
  const identity = await createPrivateKeyIdentity(privateKey)
  const now = Date.now() / 1000
  const ref = optionalEnv('ALEPH_ROOTFS_REF', '', env).trim() || undefined
  const content = {
    address: identity.address,
    time: now,
    item_type: 'ipfs' as const,
    item_hash: cid,
    payment: {
      type: rootfsStorePaymentType(env),
    },
    ...(ref ? { ref } : {}),
  }
  const itemContent = JSON.stringify(content)
  const unsignedMessage = {
    sender: identity.address,
    chain: 'ETH' as const,
    type: 'STORE' as const,
    item_hash: await sha256Hex(itemContent),
    item_type: 'inline' as const,
    item_content: itemContent,
    time: now,
    channel: buildPlan.channel,
  }
  const message = await signAlephMessage(unsignedMessage, identity.signer)
  const apiHosts = parseRootfsAlephApiHosts(buildPlan, env)
  let lastError: unknown = null

  for (const [index, apiHost] of apiHosts.entries()) {
    try {
      if (apiHosts.length > 1) {
        console.warn(`Aleph rootfs STORE API host attempt ${index + 1}/${apiHosts.length}: ${apiHost}`)
      }
      const { response, httpStatus } = await broadcastAlephMessage(message, {
        apiHost,
        sync: true,
        fetch,
        attempts: 3,
        retryDelayMs: 1000,
      })
      const status = normalizeBroadcastStatus(httpStatus, response?.message_status)
      if (status === 'rejected') {
        throw new TerminalAlephStorePublishError(
          `Aleph STORE pin was rejected: ${JSON.stringify(response?.details ?? response ?? {})}`,
        )
      }
      const pinned = {
        itemHash: typeof response?.item_hash === 'string' ? response.item_hash : message.item_hash,
        apiHost,
      }
      try {
        await waitForAlephMessageProcessed({ ...buildPlan, alephApiHost: apiHost }, pinned.itemHash)
      } catch (error) {
        if (error instanceof PendingAlephStorePublishError && !rootfsRequireProcessedStore(env)) {
          console.warn(`${error.message}; continuing with accepted Aleph STORE item hash ${pinned.itemHash}.`)
          return pinned
        }
        throw error
      }
      return pinned
    } catch (error) {
      lastError = error
      if (error instanceof TerminalAlephStorePublishError) {
        throw error
      }
      if (index < apiHosts.length - 1) {
        const message = error instanceof Error ? error.message : String(error)
        console.warn(
          `Aleph rootfs STORE API host ${apiHost} failed; retrying with ${apiHosts[index + 1]}. ${message}`,
        )
      }
    }
  }

  const suffix = lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error(
    `Aleph rootfs STORE publish failed through all configured API hosts (${apiHosts.join(', ')}). Last error: ${suffix}`,
  )
}

async function waitForAlephMessageProcessed(buildPlan: RootfsBuildPlan, itemHash: string): Promise<void> {
  for (let attempt = 1; attempt <= buildPlan.alephMessageWaitAttempts; attempt += 1) {
    try {
      const result = await inspectMessageResult(itemHash, {
        apiHost: buildPlan.alephApiHost,
        fetch,
        label: 'Aleph STORE message',
      })
      if (result.status === 'processed') return
      if (result.status === 'rejected') {
        throw new TerminalAlephStorePublishError(
          result.rejectionReason ?? `Aleph STORE message ${itemHash} was rejected.`,
        )
      }
    } catch (error) {
      if (!isTransientMessageLookupError(error) || attempt >= buildPlan.alephMessageWaitAttempts) {
        throw error
      }
    }
    if (attempt < buildPlan.alephMessageWaitAttempts) {
      await new Promise((resolve) => setTimeout(resolve, buildPlan.alephMessageWaitDelaySeconds * 1000))
    }
  }

  throw new PendingAlephStorePublishError(`Aleph STORE message ${itemHash} did not become processed in time.`)
}

async function writeRootfsManifestOutputs(result: RootfsPublishExecutionResult): Promise<void> {
  const { manifestJson, manifestPaths } = result.finalized
  await mkdir(path.dirname(manifestPaths.primaryPath), { recursive: true })
  await writeFile(manifestPaths.primaryPath, manifestJson)
  if (manifestPaths.copyTargetPath) {
    await mkdir(path.dirname(manifestPaths.copyTargetPath), { recursive: true })
    await writeFile(manifestPaths.copyTargetPath, manifestJson)
  }
  if (manifestPaths.versionedTargetPath) {
    await mkdir(path.dirname(manifestPaths.versionedTargetPath), { recursive: true })
    await writeFile(manifestPaths.versionedTargetPath, manifestJson)
  }
}

export async function emitRootfsOutputs(result: RootfsPublishExecutionResult, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await appendGithubOutput('rootfs_version', result.finalized.manifest.version, env);
  await appendGithubOutput('rootfs_manifest_path', result.finalized.manifestPaths.primaryPath, env);
  await appendGithubOutput('rootfs_manifest_json', result.finalized.manifestJson, env);
  await appendGithubOutput('rootfs_image_path', result.pipeline.buildPlan.imagePath, env);
  await appendGithubOutput('rootfs_execution_mode', result.pipeline.executionPlan.mode, env);
  if (result.finalized.manifestPaths.copyTargetPath) {
    await appendGithubOutput('rootfs_manifest_copy_target_path', result.finalized.manifestPaths.copyTargetPath, env);
  }
  if (result.finalized.manifestPaths.versionedTargetPath) {
    await appendGithubOutput('rootfs_manifest_versioned_path', result.finalized.manifestPaths.versionedTargetPath, env);
  }
  if (result.finalized.publication?.cid) {
    await appendGithubOutput('rootfs_cid', result.finalized.publication.cid, env);
  }
  if (result.finalized.publication?.itemHash) {
    await appendGithubOutput('rootfs_item_hash', result.finalized.publication.itemHash, env);
  }
  if (typeof result.finalized.publication?.sourceSizeBytes === 'number') {
    await appendGithubOutput('rootfs_source_size_bytes', result.finalized.publication.sourceSizeBytes, env);
  }
  await appendGithubSummary([
    '## Aleph Rootfs Runner',
    '',
    `- Version: \`${result.finalized.manifest.version}\``,
    `- Execution mode: \`${result.pipeline.executionPlan.mode}\``,
    `- Image path: \`${result.pipeline.buildPlan.imagePath}\``,
    `- Manifest path: \`${result.finalized.manifestPaths.primaryPath}\``,
    `- Published CID: \`${result.finalized.publication?.cid ?? ''}\``,
    `- Aleph item hash: \`${result.finalized.publication?.itemHash ?? ''}\``,
  ], env);
}

export async function runRootfsMode(
  env: NodeJS.ProcessEnv = process.env,
  hooks: {
    stdout?: (text: string) => void;
    parseInputs?: typeof parseRootfsRunnerInputs;
    buildRootfs?: typeof buildRootfs;
    runCommand?: typeof runLocalCommand;
    uploadRootfsImageToIpfs?: typeof uploadRootfsImageToIpfs;
  } = {},
): Promise<void> {
  const mode = optionalEnv('ALEPH_VM_MODE', 'rootfs-publish', env);
  const stdout = hooks.stdout ?? ((text: string) => process.stdout.write(text));
  const parsed = await (hooks.parseInputs ?? parseRootfsRunnerInputs)(env);

  if (mode === 'rootfs-build-plan') {
    stdout(`${JSON.stringify(parsed.buildPlan)}\n`);
    return;
  }

  if (mode === 'rootfs-build') {
    const result = await (hooks.buildRootfs ?? buildRootfs)(
      parsed.buildPlan,
      { run: hooks.runCommand ?? runLocalCommand },
      parsed.availability,
      { referenceRootfsDir: parsed.referenceRootfsDir },
    );
    stdout(`${JSON.stringify(result.pipeline)}\n`);
    return;
  }

  if (mode === 'rootfs-publish') {
    const originalPlan = parsed.buildPlan
    const buildPlan = originalPlan.skipUpload ? originalPlan : { ...originalPlan, skipUpload: true }
    const buildResult = await (hooks.buildRootfs ?? buildRootfs)(
      buildPlan,
      { run: hooks.runCommand ?? runLocalCommand },
      parsed.availability,
      { referenceRootfsDir: parsed.referenceRootfsDir },
    )

    let ipfsAddResponseContent: string | undefined
    let storeMessageContent: string | undefined
    if (!originalPlan.skipUpload) {
      const upload = hooks.uploadRootfsImageToIpfs
        ? await hooks.uploadRootfsImageToIpfs(originalPlan)
        : await uploadRootfsImageToIpfs(originalPlan, env)
      try {
        await waitForIpfsCidAvailable(originalPlan, upload.cid, env)
        const pinned = await pinRootfsCidOnAleph(originalPlan, upload.cid, env)

        const artifacts = publicationArtifacts(originalPlan)
        await mkdir(originalPlan.outDir, { recursive: true })
        await writeFile(artifacts.ipfsAddResponsePath, upload.responseText.endsWith('\n') ? upload.responseText : `${upload.responseText}\n`)
        storeMessageContent = JSON.stringify({ item_hash: pinned.itemHash })
        await writeFile(artifacts.storeMessagePath, `${storeMessageContent}\n`)
        await writeFile(artifacts.storeMessageStderrPath, '')
        ipfsAddResponseContent = upload.responseText
      } finally {
        await upload.cleanup?.()
      }
    }

    const finalized = finalizeRootfsBuildPipeline(originalPlan, {
      createdAt: parsed.createdAt,
      ipfsAddResponseContent,
      storeMessageContent,
    })
    const result: RootfsPublishExecutionResult = {
      pipeline: {
        ...buildResult.pipeline,
        buildPlan: originalPlan,
        publicationArtifacts: publicationArtifacts(originalPlan),
        manifestPaths: finalized.manifestPaths,
      },
      executedCommands: buildResult.executedCommands,
      finalized,
    }
    await writeRootfsManifestOutputs(result)
    await emitRootfsOutputs(result, env);
    stdout(`${JSON.stringify(result.finalized)}\n`);
    return;
  }

  throw new Error(`Unsupported ALEPH_VM_MODE "${mode}" in Aleph rootfs runner.`);
}

export async function rootfsMain(): Promise<void> {
  await runRootfsMode(process.env);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  rootfsMain().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
