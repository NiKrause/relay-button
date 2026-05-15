import type { RootfsRequiredPortForward } from '@shared-aleph/shared-types'

import { booleanEnv, integerEnv, jsonEnv, optionalEnv, requiredEnv } from './env.ts'

export interface DeployPlan {
  profile: string
  privateKey: string
  apiHost: string
  crnListUrl: string
  name: string
  sshPublicKey: string
  rootfsItemHash: string
  rootfsVersion: string
  rootfsSizeMiB: number
  crnHash: string
  preferredCountryCode: string
  geoCrnLimit: number
  maxCrnAttempts: number
  vcpus: number
  memoryMiB: number
  seconds: number
  channel: string
  waitAttempts: number
  waitDelayMs: number
  runtimeAttempts: number
  runtimeDelayMs: number
  setupAttempts: number
  setupDelayMs: number
  verifyAttempts: number
  verifyDelayMs: number
  tcpTimeoutMs: number
  httpTimeoutMs: number
  metadataAttempts: number
  metadataDelayMs: number
  metadataTimeoutMs: number
  configureTimeoutMs: number
  enableCaddyProxy: boolean
  autoConfigure: boolean
  verifyReachability: boolean
  requiredPorts: RootfsRequiredPortForward[]
  publishPortForwards: boolean
}

export function parseDeployPlan(env: NodeJS.ProcessEnv = process.env): DeployPlan {
  const requiredPorts = jsonEnv<RootfsRequiredPortForward[]>(
    'ALEPH_VM_REQUIRED_PORTS_JSON',
    '[]',
    env
  )

  return {
    profile: optionalEnv('ALEPH_VM_PROFILE', 'uc-go-peer', env),
    privateKey: requiredEnv('ALEPH_VM_PRIVATE_KEY', env),
    apiHost: optionalEnv('ALEPH_VM_API_HOST', 'https://api2.aleph.im', env),
    crnListUrl: optionalEnv('ALEPH_VM_CRN_LIST_URL', 'https://crns-list.aleph.sh/crns.json', env),
    name: requiredEnv('ALEPH_VM_NAME', env),
    sshPublicKey: requiredEnv('ALEPH_VM_SSH_PUBLIC_KEY', env),
    rootfsItemHash: requiredEnv('ALEPH_VM_ROOTFS_ITEM_HASH', env),
    rootfsVersion: optionalEnv('ALEPH_VM_ROOTFS_VERSION', '', env),
    rootfsSizeMiB: integerEnv('ALEPH_VM_ROOTFS_SIZE_MIB', 20480, env),
    crnHash: optionalEnv('ALEPH_VM_CRN_HASH', '', env),
    preferredCountryCode: optionalEnv('ALEPH_VM_PREFERRED_COUNTRY_CODE', 'DE', env),
    geoCrnLimit: integerEnv('ALEPH_VM_GEO_CRN_LIMIT', 30, env),
    maxCrnAttempts: integerEnv('ALEPH_VM_MAX_CRN_ATTEMPTS', 5, env),
    vcpus: integerEnv('ALEPH_VM_VCPUS', 1, env),
    memoryMiB: integerEnv('ALEPH_VM_MEMORY_MIB', 1024, env),
    seconds: integerEnv('ALEPH_VM_SECONDS', 30, env),
    channel: optionalEnv('ALEPH_VM_CHANNEL', 'TEST', env),
    waitAttempts: integerEnv('ALEPH_VM_WAIT_ATTEMPTS', 60, env),
    waitDelayMs: integerEnv('ALEPH_VM_WAIT_DELAY_MS', 5000, env),
    runtimeAttempts: integerEnv('ALEPH_VM_RUNTIME_ATTEMPTS', 40, env),
    runtimeDelayMs: integerEnv('ALEPH_VM_RUNTIME_DELAY_MS', 5000, env),
    setupAttempts: integerEnv('ALEPH_VM_SETUP_ATTEMPTS', 15, env),
    setupDelayMs: integerEnv('ALEPH_VM_SETUP_DELAY_MS', 4000, env),
    verifyAttempts: integerEnv('ALEPH_VM_VERIFY_ATTEMPTS', 25, env),
    verifyDelayMs: integerEnv('ALEPH_VM_VERIFY_DELAY_MS', 5000, env),
    tcpTimeoutMs: integerEnv('ALEPH_VM_TCP_TIMEOUT_MS', 5000, env),
    httpTimeoutMs: integerEnv('ALEPH_VM_HTTP_TIMEOUT_MS', 10000, env),
    metadataAttempts: integerEnv('ALEPH_VM_METADATA_ATTEMPTS', 80, env),
    metadataDelayMs: integerEnv('ALEPH_VM_METADATA_DELAY_MS', 3000, env),
    metadataTimeoutMs: integerEnv('ALEPH_VM_METADATA_TIMEOUT_MS', 240000, env),
    configureTimeoutMs: integerEnv('ALEPH_VM_CONFIGURE_TIMEOUT_MS', 180000, env),
    enableCaddyProxy: booleanEnv('ALEPH_VM_ENABLE_CADDY_PROXY', false, env),
    autoConfigure: booleanEnv('ALEPH_VM_AUTO_CONFIGURE', true, env),
    verifyReachability: booleanEnv('ALEPH_VM_VERIFY_REACHABILITY', true, env),
    requiredPorts,
    publishPortForwards: booleanEnv('ALEPH_VM_PUBLISH_PORT_FORWARDS', true, env)
  }
}
