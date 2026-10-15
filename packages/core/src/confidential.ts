import type { CrnRecord, CrnTeeProperties, TeeMode, TrustedExecution } from '@le-space/shared-types'

import type { FetchLike } from './manifests.ts'

// Confidential instances run on AMD SEV (legacy, with SEV-ES) or SEV-SNP. A
// node advertises what it can do in two places: crns.json carries a single
// `confidential_support` flag that does not tell SEV from SEV-SNP, and the
// node itself reports its CPU features and TEE properties at
// /about/usage/system and its aleph-vm version at /status/config. Surveyed on
// 2026-10-15: of 193 nodes that answered, 12 reported `sev_snp` (with a
// `properties.tee.sev_snp` block) and 3 only `sev`/`sev_es`.

/**
 * The oldest aleph-vm a confidential instance may land on. The SEV-SNP launch
 * measurement covers kernel, initrd, cmdline and owner key but not the disk;
 * 2.1.2 is where a host-supplied LUKS2 header with a null cipher stopped being
 * accepted (aleph-im/aleph-vm#1280).
 */
export const MIN_CONFIDENTIAL_ALEPH_VM_VERSION = '2.1.2'

/**
 * SEV-SNP 64-bit guest policy aleph-rs uses by default (aleph-types
 * DEFAULT_SNP_POLICY): bit 17 is reserved and must be 1, bit 16 allows SMT.
 */
export const DEFAULT_SEV_SNP_POLICY = 0x30000
const SNP_POLICY_RESERVED_BIT_17 = 0x20000

export interface ConfidentialRequirement {
  /** Defaults to sev_snp; "sev" also accepts SEV / SEV-ES-only nodes. */
  mode?: Extract<TeeMode, 'sev' | 'sev_snp'>
  /** Defaults to MIN_CONFIDENTIAL_ALEPH_VM_VERSION. */
  minVersion?: string
}

function versionParts(value: string): number[] | null {
  const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(value.trim())
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)]
}

/** Compares two aleph-vm versions; null when either does not parse. */
export function compareAlephVmVersions(left: string, right: string): number | null {
  const a = versionParts(left)
  const b = versionParts(right)
  if (!a || !b) return null
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return 0
}

function supportsSevSnp(crn: CrnRecord): boolean {
  return Boolean(crn.tee?.sev_snp) || (crn.cpu_features ?? []).includes('sev_snp')
}

function supportsSev(crn: CrnRecord): boolean {
  if (supportsSevSnp(crn)) return true
  if ((crn.cpu_features ?? []).includes('sev')) return true
  return crn.confidential_support === true
}

/**
 * Whether a node may take a confidential instance. Strict on purpose: a node
 * whose TEE support or version is unknown is refused, because landing a
 * confidential workload on a node that cannot protect it is worse than not
 * deploying. Enrich aggregate-sourced records with `enrichCrnsWithTee` first.
 */
export function isConfidentialCrn(crn: CrnRecord, requirement: ConfidentialRequirement = {}): boolean {
  const mode = requirement.mode ?? 'sev_snp'
  if (mode === 'sev_snp' ? !supportsSevSnp(crn) : !supportsSev(crn)) return false

  if (!crn.version) return false
  const comparison = compareAlephVmVersions(crn.version, requirement.minVersion ?? MIN_CONFIDENTIAL_ALEPH_VM_VERSION)
  return comparison !== null && comparison >= 0
}

function asStringArray(value: unknown): string[] | null {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : null
}

async function fetchJson(fetch: FetchLike, url: string): Promise<unknown> {
  try {
    const response = await fetch(url, { cache: 'no-cache' })
    return response.ok ? await response.json() : null
  } catch {
    return null
  }
}

/**
 * Reads a node's CPU features, TEE properties and aleph-vm version from the
 * node itself and returns an enriched copy. Fields the node does not answer
 * for are left as they were.
 */
export async function probeCrnTee<TCrn extends CrnRecord>(crn: TCrn, options: { fetch: FetchLike }): Promise<TCrn> {
  const address = crn.address ? String(crn.address).replace(/\/+$/, '') : ''
  if (!address) return crn

  const [usage, config] = await Promise.all([
    fetchJson(options.fetch, `${address}/about/usage/system`),
    fetchJson(options.fetch, `${address}/status/config`)
  ])

  const enriched: TCrn = { ...crn }
  const properties = (usage as { properties?: { cpu?: { features?: unknown }; tee?: unknown } } | null)?.properties
  const features = asStringArray(properties?.cpu?.features)
  if (features) enriched.cpu_features = features
  if (properties && 'tee' in properties) {
    enriched.tee = properties.tee && typeof properties.tee === 'object' ? (properties.tee as CrnTeeProperties) : null
  }
  const version = (config as { version?: unknown } | null)?.version
  if (typeof version === 'string' && version) enriched.version = version
  return enriched
}

/**
 * Probes the nodes whose TEE support or version is not known yet (the core
 * channel aggregate carries neither), a few at a time, keeping the order.
 */
export async function enrichCrnsWithTee<TCrn extends CrnRecord>(
  crns: ReadonlyArray<TCrn>,
  options: { fetch: FetchLike; concurrency?: number }
): Promise<TCrn[]> {
  const result = [...crns]
  const pending = result
    .map((crn, index) => ({ crn, index }))
    .filter(({ crn }) => !crn.version || (crn.cpu_features == null && crn.tee == null))
  const concurrency = Math.max(1, Number(options.concurrency) || 8)

  for (let start = 0; start < pending.length; start += concurrency) {
    const batch = pending.slice(start, start + concurrency)
    const probed = await Promise.all(batch.map(({ crn }) => probeCrnTee(crn, { fetch: options.fetch })))
    batch.forEach(({ index }, i) => {
      result[index] = probed[i]
    })
  }
  return result
}

const HEX_HASH = /^[a-fA-F0-9]{64}$/

/**
 * Refuses a trusted_execution block Aleph would reject or, worse, accept in a
 * weaker form: measured modes need the runtime bundle and the expected
 * measurements, legacy SEV needs a firmware hash.
 */
export function assertValidTrustedExecution(value: TrustedExecution): void {
  const mode = value.mode ?? 'sev'
  if (mode === 'sev') {
    if (!value.firmware || !HEX_HASH.test(value.firmware)) {
      throw new Error('trusted_execution: legacy SEV needs a 64-character firmware item hash.')
    }
    if (value.runtime || value.measurements) {
      throw new Error('trusted_execution: runtime and measurements belong to measured modes, not legacy SEV.')
    }
    return
  }

  if (value.firmware) {
    throw new Error(`trusted_execution: firmware is for legacy SEV only, not ${mode}.`)
  }
  if (!value.runtime || !HEX_HASH.test(value.runtime)) {
    throw new Error(`trusted_execution: ${mode} needs the runtime bundle's 64-character item hash.`)
  }
  const measurements = value.measurements ?? []
  if (measurements.length === 0 || measurements.some((m) => m.platform !== mode || Object.keys(m.registers ?? {}).length === 0)) {
    throw new Error(`trusted_execution: ${mode} needs expected measurements for platform ${mode}.`)
  }
  if (mode === 'sev_snp' && value.policy !== undefined && (value.policy & SNP_POLICY_RESERVED_BIT_17) === 0) {
    throw new Error('trusted_execution: an SEV-SNP policy must set the reserved bit 17 (e.g. 0x30000).')
  }
  if (mode === 'tdx' && value.policy !== undefined) {
    throw new Error('trusted_execution: tdx has no host-chosen policy; leave it unset.')
  }
  if (value.attestation_port !== undefined && !(Number.isInteger(value.attestation_port) && value.attestation_port > 0 && value.attestation_port < 65536)) {
    throw new Error('trusted_execution: attestation_port must be a TCP port.')
  }
}
