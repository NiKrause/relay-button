import path from 'node:path'

import type { RootfsContract } from './contract.ts'

export type RootfsBuildDriver = 'auto' | 'host' | 'docker'

export interface RootfsBuildOptions {
  projectDir: string
  alephDir?: string
  outDir?: string
  contractPath?: string
  driver?: RootfsBuildDriver
  rootfsSizeMiB?: number
  rootfsImageSize?: string
  rootfsVersion?: string
  channel?: string
  skipUpload?: boolean
  skipBuild?: boolean
  ipfsAddUrl?: string
  ipfsGatewayUrl?: string
  alephApiHost?: string
  alephMessageWaitAttempts?: number
  alephMessageWaitDelaySeconds?: number
  alephPinAttempts?: number
  alephPinDelaySeconds?: number
  ipfsGatewayWaitAttempts?: number
  ipfsGatewayWaitDelaySeconds?: number
  gitShortSha?: string | null
  now?: Date
}

export interface RootfsBuildPlan {
  contract: RootfsContract
  contractPath: string
  projectDir: string
  alephDir: string
  outDir: string
  driver: RootfsBuildDriver
  rootfsSizeMiB: number
  rootfsImageSize: string
  rootfsVersion: string
  channel: string
  skipUpload: boolean
  skipBuild: boolean
  ipfsAddUrl: string
  ipfsGatewayUrl: string
  alephApiHost: string
  alephMessageWaitAttempts: number
  alephMessageWaitDelaySeconds: number
  alephPinAttempts: number
  alephPinDelaySeconds: number
  ipfsGatewayWaitAttempts: number
  ipfsGatewayWaitDelaySeconds: number
  manifestPath: string
  latestManifestPath: string | null
  versionedManifestPath: string | null
  imagePath: string
  baseImagePath: string
  binaryPath: string
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}

export function deriveRootfsVersion(options: Pick<RootfsBuildOptions, 'rootfsVersion' | 'gitShortSha' | 'now'> = {}): string {
  if (options.rootfsVersion && options.rootfsVersion.trim()) {
    return options.rootfsVersion.trim()
  }

  if (options.gitShortSha && options.gitShortSha.trim()) {
    const now = options.now ?? new Date()
    const yyyy = String(now.getUTCFullYear())
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0')
    const dd = String(now.getUTCDate()).padStart(2, '0')
    return `uc-go-peer-git-${yyyy}${mm}${dd}-${options.gitShortSha.trim()}`
  }

  return 'uc-go-peer-v0.1.0'
}

export function createRootfsBuildPlan(contract: RootfsContract, options: RootfsBuildOptions): RootfsBuildPlan {
  const projectDir = path.resolve(options.projectDir)
  const alephDir = path.resolve(options.alephDir ?? path.join(projectDir, 'go-peer/aleph'))
  const outDir = path.resolve(options.outDir ?? path.join(alephDir, 'dist-rootfs'))
  const contractPath = path.resolve(options.contractPath ?? path.join(alephDir, 'root-profiles', `${contract.id}.json`))
  const rootfsVersion = deriveRootfsVersion(options)

  const copyTarget = contract.manifest.copyTarget?.trim() ?? ''
  const latestManifestPath = copyTarget
    ? path.resolve(copyTarget.startsWith('/') ? copyTarget : path.join(projectDir, copyTarget))
    : null
  const versionedManifestPath = latestManifestPath
    ? path.join(path.dirname(latestManifestPath), `${rootfsVersion}.json`)
    : null

  return {
    contract,
    contractPath,
    projectDir,
    alephDir,
    outDir,
    driver: options.driver ?? 'auto',
    rootfsSizeMiB: positiveInteger(options.rootfsSizeMiB, 20480),
    rootfsImageSize: options.rootfsImageSize?.trim() || '20G',
    rootfsVersion,
    channel: options.channel?.trim() || 'ALEPH-CLOUDSOLUTIONS',
    skipUpload: options.skipUpload === true,
    skipBuild: options.skipBuild === true,
    ipfsAddUrl: options.ipfsAddUrl?.trim() || 'https://ipfs.aleph.cloud/api/v0/add',
    ipfsGatewayUrl: options.ipfsGatewayUrl?.trim() || 'https://ipfs.aleph.cloud/ipfs',
    alephApiHost: options.alephApiHost?.trim() || 'https://api2.aleph.im',
    alephMessageWaitAttempts: positiveInteger(options.alephMessageWaitAttempts, 60),
    alephMessageWaitDelaySeconds: positiveInteger(options.alephMessageWaitDelaySeconds, 5),
    alephPinAttempts: positiveInteger(options.alephPinAttempts, 4),
    alephPinDelaySeconds: positiveInteger(options.alephPinDelaySeconds, 10),
    ipfsGatewayWaitAttempts: positiveInteger(options.ipfsGatewayWaitAttempts, 30),
    ipfsGatewayWaitDelaySeconds: positiveInteger(options.ipfsGatewayWaitDelaySeconds, 10),
    manifestPath: path.join(outDir, 'rootfs-manifest.json'),
    latestManifestPath,
    versionedManifestPath,
    imagePath: path.join(outDir, 'aleph-uc-go-peer.qcow2'),
    baseImagePath: path.join(outDir, 'debian-12-genericcloud-amd64.qcow2'),
    binaryPath: path.join(outDir, 'universal-chat-go')
  }
}

export function rootfsBuildShellEnv(plan: RootfsBuildPlan): Record<string, string> {
  return {
    OUT_DIR: plan.outDir,
    ROOTFS_CONTRACT_FILE: plan.contractPath,
    ROOTFS_BUILD_DRIVER: plan.driver,
    ROOTFS_SIZE_MIB: String(plan.rootfsSizeMiB),
    ROOTFS_IMAGE_SIZE: plan.rootfsImageSize,
    ROOTFS_VERSION: plan.rootfsVersion,
    CHANNEL: plan.channel,
    SKIP_UPLOAD: plan.skipUpload ? '1' : '0',
    SKIP_BUILD: plan.skipBuild ? '1' : '0',
    IPFS_ADD_URL: plan.ipfsAddUrl,
    IPFS_GATEWAY_URL: plan.ipfsGatewayUrl,
    ALEPH_API_HOST: plan.alephApiHost,
    ALEPH_MESSAGE_WAIT_ATTEMPTS: String(plan.alephMessageWaitAttempts),
    ALEPH_MESSAGE_WAIT_DELAY_SECONDS: String(plan.alephMessageWaitDelaySeconds),
    ALEPH_PIN_ATTEMPTS: String(plan.alephPinAttempts),
    ALEPH_PIN_DELAY_SECONDS: String(plan.alephPinDelaySeconds),
    IPFS_GATEWAY_WAIT_ATTEMPTS: String(plan.ipfsGatewayWaitAttempts),
    IPFS_GATEWAY_WAIT_DELAY_SECONDS: String(plan.ipfsGatewayWaitDelaySeconds)
  }
}
