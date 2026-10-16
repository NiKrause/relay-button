// Browser-side SEV-SNP attestation verification (relay-button#169).
//
// verifyAttestation fetches the VCEK and the product CRL from AMD's KDS
// (which allows any origin) and hands them, with the report, to the WASM
// verifier: AMD certificate chain, report signature, revocation, TCB floor,
// then the launch measurement and guest policy the INSTANCE message pinned.
// It throws with the reason when anything does not hold; nothing is sent to
// the guest here.
//
// `wasm` is the generated module: `import * as wasm from './pkg/relay_button_attest.js'`
// (after `await wasm.default()` in a browser), or `require('./pkg-node/…')` in Node.

/**
 * @param {object} args
 * @param {{ reportInfo: Function, verifyReport: Function }} args.wasm
 * @param {Uint8Array} args.report raw SNP report bytes
 * @param {'Milan'|'Genoa'|'Turin'} args.product AMD product line of the node's CPU
 * @param {string[]} args.expectedMeasurements launch digests the INSTANCE message pins (hex)
 * @param {string|number|bigint} [args.expectedPolicy] guest policy the message pins
 * @param {[number, number, number, number]} [args.minTcb] network TCB floor [bootloader, tee, snp, microcode]
 * @param {typeof fetch} [args.fetch]
 * @param {number} [args.nowSeconds]
 */
export async function verifyAttestation({
  wasm,
  report,
  product,
  expectedMeasurements,
  expectedPolicy,
  minTcb,
  fetch: fetchImpl = globalThis.fetch,
  nowSeconds = Date.now() / 1000,
}) {
  if (!Array.isArray(expectedMeasurements) || expectedMeasurements.length === 0) {
    throw new Error('verifyAttestation needs the launch measurements the INSTANCE message pins')
  }
  const info = wasm.reportInfo(report, product)
  const [vcek, crl] = await Promise.all([
    fetchBytes(fetchImpl, info.vcekUrl, 'VCEK'),
    fetchBytes(fetchImpl, info.crlUrl, 'CRL'),
  ])
  return wasm.verifyReport(
    report,
    product,
    vcek,
    crl,
    nowSeconds,
    expectedMeasurements,
    expectedPolicy == null ? null : String(expectedPolicy),
    minTcb ? Uint8Array.from(minTcb) : null,
  )
}

async function fetchBytes(fetchImpl, url, what) {
  const response = await fetchImpl(url)
  if (!response.ok) {
    // A 404 for the VCEK means AMD has no certificate for this chip at this
    // TCB: the report cannot be verified, so it must not be trusted.
    throw new Error(`AMD KDS answered ${response.status} for the ${what}: ${url}`)
  }
  return new Uint8Array(await response.arrayBuffer())
}

/** The launch measurements an SEV-SNP INSTANCE message pins. */
export function pinnedMeasurements(instanceContent) {
  const tee = instanceContent?.environment?.trusted_execution
  return (tee?.measurements ?? [])
    .filter((entry) => entry?.platform === 'sev_snp' && typeof entry?.registers?.launch === 'string')
    .map((entry) => entry.registers.launch)
}
