import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

import { clearKdsCache, pinnedMeasurements, verifyAttestation } from '../js/index.mjs'

const require = createRequire(import.meta.url)
const wasm = require('../pkg-node/relay_button_attest.js')

const fixture = async (name) => new Uint8Array(await readFile(new URL(`../testdata/${name}`, import.meta.url)))
const report = Buffer.from((await readFile(new URL('../testdata/report_milan.hex', import.meta.url), 'utf8')).trim(), 'hex')
const vcek = await fixture('vcek_milan.der')
const crl = await fixture('crl_milan.der')
const NOW = 1787011200 // inside the fixture CRL's window

// Serves the fixture VCEK and CRL in place of AMD's KDS.
const kds = async (url) => {
  const body = String(url).endsWith('/crl') ? crl : vcek
  return new Response(body, { status: 200 })
}

test('reportInfo names the KDS URLs for the report', () => {
  const info = wasm.reportInfo(report, 'Milan')
  assert.match(info.vcekUrl, /^https:\/\/kdsintf\.amd\.com\/vcek\/v1\/Milan\/[0-9a-f]{128}\?blSPL=/)
  assert.equal(info.crlUrl, 'https://kdsintf.amd.com/vcek/v1/Milan/crl')
  assert.equal(info.measurement.length, 96)
})

test('the genuine report passes chain and signature and stops at the TCB floor', async () => {
  // The fixture predates AMD's SB-3019 floor, which verifyReport always
  // applies: reaching that check means the chain, signature and CRL held.
  const { measurement } = wasm.reportInfo(report, 'Milan')
  await assert.rejects(
    verifyAttestation({ wasm, report, product: 'Milan', expectedMeasurements: [measurement], fetch: kds, nowSeconds: NOW }),
    /below floor/,
  )
})

test('a tampered report fails the signature check, before any TCB check', async () => {
  const tampered = Uint8Array.from(report)
  tampered[0x90] ^= 0xff
  const { measurement } = wasm.reportInfo(report, 'Milan')
  await assert.rejects(
    verifyAttestation({ wasm, report: tampered, product: 'Milan', expectedMeasurements: [measurement], fetch: kds, nowSeconds: NOW }),
    (error) => !/below floor/.test(error.message),
  )
})

test('a VCEK that AMD does not have is a refusal, not a pass', async () => {
  clearKdsCache()
  const { measurement } = wasm.reportInfo(report, 'Milan')
  await assert.rejects(
    verifyAttestation({ wasm, report, product: 'Milan', expectedMeasurements: [measurement], fetch: async () => new Response('', { status: 404 }), nowSeconds: NOW }),
    /AMD KDS answered 404 for the VCEK/,
  )
})

test('pinnedMeasurements reads the INSTANCE message', () => {
  const content = { environment: { trusted_execution: { mode: 'sev_snp', measurements: [
    { platform: 'sev_snp', registers: { launch: 'aa' }, vcpu_type: 'EPYC-v4' },
    { platform: 'tdx', registers: { mrtd: 'bb' } },
  ] } } }
  assert.deepEqual(pinnedMeasurements(content), ['aa'])
  assert.deepEqual(pinnedMeasurements({}), [])
})

test('KDS answers are cached, and a 429 is retried as AMD says', async () => {
  clearKdsCache()
  const { measurement } = wasm.reportInfo(report, 'Milan')
  const requests = []
  const waits = []
  let limited = true
  const flakyKds = async (url) => {
    requests.push(String(url).endsWith('/crl') ? 'crl' : 'vcek')
    if (limited && !String(url).endsWith('/crl')) {
      limited = false
      return new Response('', { status: 429, headers: { 'retry-after': '3' } })
    }
    return kds(url)
  }
  const run = () => verifyAttestation({ wasm, report, product: 'Milan', expectedMeasurements: [measurement], fetch: flakyKds, nowSeconds: NOW, sleep: async (ms) => waits.push(ms) })
  await assert.rejects(run(), /below floor/) // reached the TCB check: fetched and verified
  await assert.rejects(run(), /below floor/)
  assert.deepEqual(waits, [3000], 'waited as Retry-After said')
  assert.deepEqual(requests.sort(), ['crl', 'vcek', 'vcek'], 'the second verification used the cache')
})
