import test from 'node:test'
import assert from 'node:assert/strict'

import type { CrnRecord } from '@le-space/shared-types'

import {
  DEFAULT_SEV_SNP_POLICY,
  MIN_CONFIDENTIAL_ALEPH_VM_VERSION,
  assertValidTrustedExecution,
  compareAlephVmVersions,
  enrichCrnsWithTee,
  isConfidentialCrn,
  probeCrnTee
} from '../src/confidential.ts'
import { filterDeployableCrns } from '../src/crns.ts'
import { createInstanceContent } from '../src/instance-deployment.ts'

function jsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload
    }
  }
}

const HASH = (c: string) => c.repeat(64)
const snpTee = { sev_snp: { supported_vcpu_types: ['EPYC-v4', 'EPYC-Milan'] } }

test('compareAlephVmVersions orders aleph-vm versions and refuses what does not parse', () => {
  assert.ok((compareAlephVmVersions('2.1.4', MIN_CONFIDENTIAL_ALEPH_VM_VERSION) ?? 0) > 0)
  assert.equal(compareAlephVmVersions('2.1.2', '2.1.2'), 0)
  assert.ok((compareAlephVmVersions('2.1.1', '2.1.2') ?? 0) < 0)
  assert.ok((compareAlephVmVersions('1.15.0', '2.1.2') ?? 0) < 0)
  assert.ok((compareAlephVmVersions('v2.2', '2.1.9') ?? 0) > 0)
  assert.equal(compareAlephVmVersions('unknown', '2.1.2'), null)
})

test('isConfidentialCrn wants SEV-SNP and a patched aleph-vm by default', () => {
  const snp: CrnRecord = { hash: 'a', version: '2.1.4', cpu_features: ['sev', 'sev_es', 'sev_snp'], tee: snpTee }
  assert.equal(isConfidentialCrn(snp), true)

  // SEV-SNP but older than the LUKS2 header fix
  assert.equal(isConfidentialCrn({ ...snp, version: '2.1.1' }), false)
  // the reported feature alone is enough evidence of SEV-SNP
  assert.equal(isConfidentialCrn({ hash: 'b', version: '2.1.4', cpu_features: ['sev', 'sev_es', 'sev_snp'] }), true)
  // only SEV / SEV-ES
  assert.equal(isConfidentialCrn({ hash: 'c', version: '2.1.4', cpu_features: ['sev', 'sev_es'] }), false)
  // crns.json's flag does not say which generation it is
  assert.equal(isConfidentialCrn({ hash: 'd', version: '2.1.4', confidential_support: true }), false)
  // unknown version is refused, not assumed
  assert.equal(isConfidentialCrn({ hash: 'e', cpu_features: ['sev_snp'], tee: snpTee }), false)
  // a plain node
  assert.equal(isConfidentialCrn({ hash: 'f', version: '2.1.4', cpu_features: [] }), false)
})

test('isConfidentialCrn in sev mode also takes SEV / SEV-ES nodes and the list flag', () => {
  assert.equal(isConfidentialCrn({ hash: 'c', version: '2.1.4', cpu_features: ['sev', 'sev_es'] }, { mode: 'sev' }), true)
  assert.equal(isConfidentialCrn({ hash: 'd', version: '2.1.4', confidential_support: true }, { mode: 'sev' }), true)
  assert.equal(isConfidentialCrn({ hash: 'f', version: '2.1.4', cpu_features: [] }, { mode: 'sev' }), false)
  assert.equal(
    isConfidentialCrn({ hash: 'g', version: '2.1.0', cpu_features: ['sev'] }, { mode: 'sev', minVersion: '2.0.0' }),
    true
  )
})

test('probeCrnTee reads features, TEE block and version from the node itself', async () => {
  const requested: string[] = []
  const crn = await probeCrnTee<CrnRecord>(
    { hash: 'n', address: 'https://crn.example.com/' },
    {
      fetch: async (url) => {
        requested.push(String(url))
        if (String(url).endsWith('/about/usage/system')) {
          return jsonResponse({ properties: { cpu: { features: ['sev', 'sev_es', 'sev_snp'] }, tee: snpTee } })
        }
        if (String(url).endsWith('/status/config')) return jsonResponse({ version: '2.1.4' })
        return jsonResponse({}, 404)
      }
    }
  )

  assert.deepEqual(requested.sort(), ['https://crn.example.com/about/usage/system', 'https://crn.example.com/status/config'])
  assert.deepEqual(crn.cpu_features, ['sev', 'sev_es', 'sev_snp'])
  assert.deepEqual(crn.tee, snpTee)
  assert.equal(crn.version, '2.1.4')
  assert.equal(isConfidentialCrn(crn), true)
})

test('probeCrnTee leaves a silent node as it was', async () => {
  const original: CrnRecord = { hash: 'n', address: 'https://down.example.com', version: '2.1.4' }
  const crn = await probeCrnTee(original, {
    fetch: async () => {
      throw new Error('connection refused')
    }
  })
  assert.deepEqual(crn, original)
  assert.equal(isConfidentialCrn(crn), false)
})

test('probeCrnTee records a node that reports no TEE at all', async () => {
  const crn = await probeCrnTee<CrnRecord>(
    { hash: 'p', address: 'https://plain.example.com' },
    {
      fetch: async (url) =>
        String(url).endsWith('/about/usage/system')
          ? jsonResponse({ properties: { cpu: { features: [] }, tee: null } })
          : jsonResponse({ version: '2.1.4' })
    }
  )
  assert.deepEqual(crn.cpu_features, [])
  assert.equal(crn.tee, null)
})

test('enrichCrnsWithTee probes only what is unknown and keeps the order', async () => {
  const probed: string[] = []
  const crns: CrnRecord[] = [
    { hash: 'known', address: 'https://known.example.com', version: '2.1.4', cpu_features: ['sev_snp'] },
    { hash: 'fresh-1', address: 'https://fresh-1.example.com' },
    { hash: 'fresh-2', address: 'https://fresh-2.example.com' }
  ]
  const result = await enrichCrnsWithTee(crns, {
    concurrency: 1,
    fetch: async (url) => {
      const host = new URL(String(url)).hostname
      probed.push(host)
      if (String(url).endsWith('/status/config')) return jsonResponse({ version: '2.1.4' })
      return jsonResponse({ properties: { cpu: { features: host.startsWith('fresh-1') ? ['sev', 'sev_es', 'sev_snp'] : [] } } })
    }
  })

  assert.deepEqual(result.map((crn) => crn.hash), ['known', 'fresh-1', 'fresh-2'])
  assert.ok(!probed.includes('known.example.com'))
  assert.deepEqual(result.filter((crn) => isConfidentialCrn(crn)).map((crn) => crn.hash), ['known', 'fresh-1'])
})

test('filterDeployableCrns keeps only confidential-capable nodes when asked', () => {
  const crns: CrnRecord[] = [
    { hash: 'snp-old', score: 0.99, version: '2.1.1', cpu_features: ['sev_snp'] },
    { hash: 'plain', score: 0.98, version: '2.1.4', cpu_features: [] },
    { hash: 'snp', score: 0.9, version: '2.1.4', cpu_features: ['sev', 'sev_es', 'sev_snp'], tee: snpTee },
    { hash: 'sev', score: 0.95, version: '2.1.4', cpu_features: ['sev', 'sev_es'] }
  ]

  assert.deepEqual(filterDeployableCrns(crns).map((crn) => crn.hash), ['snp-old', 'plain', 'sev', 'snp'])
  assert.deepEqual(filterDeployableCrns(crns, { confidential: {} }).map((crn) => crn.hash), ['snp'])
  assert.deepEqual(filterDeployableCrns(crns, { confidential: { mode: 'sev' } }).map((crn) => crn.hash), ['sev', 'snp'])
})

const snpExecution = {
  mode: 'sev_snp' as const,
  policy: DEFAULT_SEV_SNP_POLICY,
  runtime: HASH('a'),
  measurements: [{ platform: 'sev_snp' as const, registers: { launch: 'ab'.repeat(48) }, vcpu_type: 'EPYC-v4' }]
}

test('assertValidTrustedExecution accepts a complete SEV-SNP and a legacy SEV block', () => {
  assert.doesNotThrow(() => assertValidTrustedExecution(snpExecution))
  assert.doesNotThrow(() => assertValidTrustedExecution({ firmware: HASH('b'), policy: 1 }))
  assert.doesNotThrow(() => assertValidTrustedExecution({ mode: 'sev', firmware: HASH('b') }))
})

test('assertValidTrustedExecution refuses blocks Aleph would reject or weaken', () => {
  assert.throws(() => assertValidTrustedExecution({ mode: 'sev_snp', measurements: snpExecution.measurements }), /runtime/)
  assert.throws(() => assertValidTrustedExecution({ mode: 'sev_snp', runtime: HASH('a') }), /measurements/)
  assert.throws(
    () => assertValidTrustedExecution({ ...snpExecution, measurements: [{ platform: 'tdx', registers: { mrtd: 'x' } }] }),
    /measurements/
  )
  assert.throws(() => assertValidTrustedExecution({ ...snpExecution, firmware: HASH('b') }), /legacy SEV only/)
  assert.throws(() => assertValidTrustedExecution({ ...snpExecution, policy: 0x10000 }), /bit 17/)
  assert.throws(() => assertValidTrustedExecution({ ...snpExecution, attestation_port: 70000 }), /attestation_port/)
  assert.throws(() => assertValidTrustedExecution({}), /firmware/)
  assert.throws(() => assertValidTrustedExecution({ firmware: HASH('b'), runtime: HASH('a') }), /measured modes/)
  assert.throws(
    () =>
      assertValidTrustedExecution({
        mode: 'tdx',
        policy: 1,
        runtime: HASH('a'),
        measurements: [{ platform: 'tdx', registers: { mrtd: 'x' } }]
      }),
    /tdx/
  )
})

const baseContent = {
  address: '0xabc',
  name: 'confidential-app',
  sshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIG9A7L1fCP0f3dYxFJ0P0XrJ1hV6X4kRrS0vQd2c8mS0 user@example',
  rootfsItemHash: '380b99e0577fb7771f1b3c0a369f4abff9094e9205b0b466783453299ef9f4f2',
  rootfsSizeMiB: 40960,
  vcpus: 2,
  memoryMiB: 4096,
  now: 1
}

test('createInstanceContent carries trusted_execution for a confidential instance', () => {
  const content = createInstanceContent({ ...baseContent, trustedExecution: snpExecution })
  assert.deepEqual(content.environment.trusted_execution, snpExecution)
  assert.equal(content.environment.hypervisor, 'qemu')
})

test('createInstanceContent leaves a normal instance without trusted_execution', () => {
  const content = createInstanceContent(baseContent)
  assert.equal('trusted_execution' in content.environment, false)
})

test('createInstanceContent refuses an incomplete confidential instance before building it', () => {
  assert.throws(
    () => createInstanceContent({ ...baseContent, trustedExecution: { mode: 'sev_snp', runtime: HASH('a') } }),
    /measurements/
  )
})
