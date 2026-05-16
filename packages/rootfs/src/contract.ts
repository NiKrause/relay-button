import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

export interface RootfsContractPort {
  port: number
  tcp?: boolean
  udp?: boolean
  purpose?: string
}

export interface RootfsContractRootfs {
  profile: string
  installMode: string
  installDir: string
  binaryPath: string
  dataDir: string
  envFile: string
}

export interface RootfsContractServices {
  bootstrap: string
  main: string
  autotlsRefresh: string
}

export interface RootfsContractManifest {
  copyTarget: string
  notes?: string
}

export interface RootfsContractSource {
  repository?: string
  subdirectory?: string
}

export interface RootfsContract {
  schemaVersion: number
  id: string
  displayName?: string
  source?: RootfsContractSource
  rootfs: RootfsContractRootfs
  services: RootfsContractServices
  ports: RootfsContractPort[]
  manifest: RootfsContractManifest
}

export interface RootfsContractState {
  contract: RootfsContract | null
  valid: boolean
  errors: string[]
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function parsePorts(value: unknown, errors: string[]): RootfsContractPort[] {
  if (!Array.isArray(value)) {
    errors.push('ports must be an array')
    return []
  }

  return value.flatMap((entry, index) => {
    const port = asObject(entry)
    if (!port) {
      errors.push(`ports[${index}] must be an object`)
      return []
    }

    const portNumber = asNumber(port.port)
    if (portNumber == null || portNumber < 1 || portNumber > 65535) {
      errors.push(`ports[${index}].port must be an integer between 1 and 65535`)
      return []
    }

    return [{
      port: portNumber,
      tcp: port.tcp === true,
      udp: port.udp === true,
      purpose: asString(port.purpose) ?? undefined
    }]
  })
}

export function validateRootfsContract(input: unknown): RootfsContractState {
  const errors: string[] = []
  const payload = asObject(input)
  if (!payload) {
    return { contract: null, valid: false, errors: ['rootfs contract must be an object'] }
  }

  const rootfs = asObject(payload.rootfs)
  const services = asObject(payload.services)
  const manifest = asObject(payload.manifest)
  const source = asObject(payload.source) ?? undefined

  const schemaVersion = asNumber(payload.schemaVersion)
  if (schemaVersion == null || !Number.isInteger(schemaVersion)) {
    errors.push('schemaVersion must be an integer')
  }

  const id = asString(payload.id)
  if (!id) {
    errors.push('id must be a non-empty string')
  }

  if (!rootfs) {
    errors.push('rootfs must be an object')
  }
  if (!services) {
    errors.push('services must be an object')
  }
  if (!manifest) {
    errors.push('manifest must be an object')
  }

  const profile = asString(rootfs?.profile)
  if (!profile) errors.push('rootfs.profile must be a non-empty string')
  const installMode = asString(rootfs?.installMode)
  if (!installMode) errors.push('rootfs.installMode must be a non-empty string')
  const installDir = asString(rootfs?.installDir)
  if (!installDir) errors.push('rootfs.installDir must be a non-empty string')
  const binaryPath = asString(rootfs?.binaryPath) ?? '/usr/local/bin/universal-chat-go'
  const dataDir = asString(rootfs?.dataDir)
  if (!dataDir) errors.push('rootfs.dataDir must be a non-empty string')
  const envFile = asString(rootfs?.envFile)
  if (!envFile) errors.push('rootfs.envFile must be a non-empty string')

  const bootstrap = asString(services?.bootstrap)
  if (!bootstrap) errors.push('services.bootstrap must be a non-empty string')
  const main = asString(services?.main)
  if (!main) errors.push('services.main must be a non-empty string')
  const autotlsRefresh = asString(services?.autotlsRefresh)
  if (!autotlsRefresh) errors.push('services.autotlsRefresh must be a non-empty string')

  const copyTarget = asString(manifest?.copyTarget)
  if (!copyTarget) errors.push('manifest.copyTarget must be a non-empty string')

  const ports = parsePorts(payload.ports, errors)

  if (errors.length > 0 || !schemaVersion || !id || !profile || !installMode || !installDir || !dataDir || !envFile || !bootstrap || !main || !autotlsRefresh || !copyTarget) {
    return { contract: null, valid: false, errors }
  }

  return {
    contract: {
      schemaVersion,
      id,
      displayName: asString(payload.displayName) ?? undefined,
      source: source
        ? {
            repository: asString(source.repository) ?? undefined,
            subdirectory: asString(source.subdirectory) ?? undefined
          }
        : undefined,
      rootfs: { profile, installMode, installDir, binaryPath, dataDir, envFile },
      services: { bootstrap, main, autotlsRefresh },
      ports,
      manifest: { copyTarget, notes: asString(manifest?.notes) ?? undefined }
    },
    valid: true,
    errors: []
  }
}

export function parseRootfsContract(input: string | unknown): RootfsContract {
  const payload = typeof input === 'string' ? JSON.parse(input) : input
  const result = validateRootfsContract(payload)
  if (!result.valid || !result.contract) {
    throw new Error(`Invalid rootfs contract: ${result.errors.join('; ')}`)
  }
  return result.contract
}

export async function readRootfsContractFile(path: string): Promise<RootfsContract> {
  return parseRootfsContract(await readFile(path, 'utf8'))
}

export function contractShellEnv(contract: RootfsContract, contractPath = ''): Record<string, string> {
  return {
    ROOTFS_CONTRACT_PATH: contractPath,
    ROOTFS_CONTRACT_ID: contract.id,
    ROOTFS_CONTRACT_PROFILE: contract.rootfs.profile,
    ROOTFS_CONTRACT_INSTALL_MODE: contract.rootfs.installMode,
    ROOTFS_CONTRACT_SOURCE_SUBDIRECTORY: contract.source?.subdirectory ?? '',
    ROOTFS_CONTRACT_INSTALL_DIR: contract.rootfs.installDir,
    ROOTFS_CONTRACT_BINARY_PATH: contract.rootfs.binaryPath,
    ROOTFS_CONTRACT_DATA_DIR: contract.rootfs.dataDir,
    ROOTFS_CONTRACT_ENV_FILE: contract.rootfs.envFile,
    ROOTFS_CONTRACT_MAIN_SERVICE: contract.services.main,
    ROOTFS_CONTRACT_BOOTSTRAP_SERVICE: contract.services.bootstrap,
    ROOTFS_CONTRACT_AUTOTLS_SERVICE: contract.services.autotlsRefresh,
    ROOTFS_CONTRACT_MANIFEST_COPY_TARGET: contract.manifest.copyTarget,
    ROOTFS_CONTRACT_MANIFEST_NOTES: contract.manifest.notes ?? '',
    ROOTFS_CONTRACT_PORT_FORWARDS_JSON: JSON.stringify(contract.ports)
  }
}

export function referenceProfileRoot(profile: string): string {
  return fileURLToPath(new URL(`../reference/${profile}/`, import.meta.url))
}

export function referenceProfileContractPath(profile: string): string {
  return fileURLToPath(new URL(`../reference/${profile}/contract.json`, import.meta.url))
}

export function referenceProfileRootfsDir(profile: string): string {
  return fileURLToPath(new URL(`../reference/${profile}/rootfs/`, import.meta.url))
}
