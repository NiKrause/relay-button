#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import path from 'node:path'

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function shellAssign(name, value) {
  return `${name}=${shellQuote(value)}`
}

const contractPath = process.argv[2]
if (!contractPath) {
  console.error('Usage: read-rootfs-contract.mjs /path/to/contract.json')
  process.exit(1)
}

let payload
try {
  payload = JSON.parse(readFileSync(contractPath, 'utf8'))
} catch (error) {
  console.error(`Failed to read rootfs contract ${contractPath}: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

const rootfs = payload.rootfs ?? {}
const services = payload.services ?? {}
const source = payload.source ?? {}
const manifest = payload.manifest ?? {}
const ports = Array.isArray(payload.ports) ? payload.ports : null
const profile = typeof rootfs.profile === 'string' ? rootfs.profile.trim() : ''
const installMode = typeof rootfs.installMode === 'string' ? rootfs.installMode.trim() : ''

if (!profile) {
  console.error('Rootfs contract is missing rootfs.profile')
  process.exit(1)
}
if (!installMode) {
  console.error('Rootfs contract is missing rootfs.installMode')
  process.exit(1)
}
if (!ports) {
  console.error('Rootfs contract field ports must be a list')
  process.exit(1)
}

const resolvedContractPath = path.resolve(contractPath)
const lines = [
  shellAssign('ROOTFS_CONTRACT_PATH', resolvedContractPath),
  shellAssign('ROOTFS_CONTRACT_ID', payload.id ?? ''),
  shellAssign('ROOTFS_CONTRACT_PROFILE', profile),
  shellAssign('ROOTFS_CONTRACT_INSTALL_MODE', installMode),
  shellAssign('ROOTFS_CONTRACT_SOURCE_SUBDIRECTORY', source.subdirectory ?? ''),
  shellAssign('ROOTFS_CONTRACT_INSTALL_DIR', rootfs.installDir ?? ''),
  shellAssign('ROOTFS_CONTRACT_BINARY_PATH', rootfs.binaryPath ?? '/usr/local/bin/universal-chat-go'),
  shellAssign('ROOTFS_CONTRACT_DATA_DIR', rootfs.dataDir ?? ''),
  shellAssign('ROOTFS_CONTRACT_ENV_FILE', rootfs.envFile ?? ''),
  shellAssign('ROOTFS_CONTRACT_MAIN_SERVICE', services.main ?? ''),
  shellAssign('ROOTFS_CONTRACT_BOOTSTRAP_SERVICE', services.bootstrap ?? ''),
  shellAssign('ROOTFS_CONTRACT_AUTOTLS_SERVICE', services.autotlsRefresh ?? ''),
  shellAssign('ROOTFS_CONTRACT_MANIFEST_COPY_TARGET', manifest.copyTarget ?? ''),
  shellAssign('ROOTFS_CONTRACT_MANIFEST_NOTES', manifest.notes ?? ''),
  shellAssign('ROOTFS_CONTRACT_PORT_FORWARDS_JSON', JSON.stringify(ports)),
]

process.stdout.write(`${lines.join('\n')}\n`)
