// A confidential instance from the browser, end to end (relay-button#169,
// step 4): the trusted_execution block for the INSTANCE message, and the
// attest-then-unlock once the node runs it. The widget and the live script
// both use these, so the browser path is the one that was tested.

import { attestGuest, injectSecrets, websocketTransport } from './ratls.mjs'
import { DEFAULT_SNP_POLICY, fetchInstanceRuntime, resolveInstanceRuntime, trustedExecution } from './runtime.mjs'

const DEFAULT_API = 'https://api2.aleph.im'

/**
 * `environment.trusted_execution` for a new SEV-SNP instance of `owner`,
 * computed here: the network's default SNP runtime (or `runtimeName`), its
 * bundle checked against its manifest, one launch digest per CPU model.
 */
export async function confidentialTrustedExecution({
  wasm,
  owner,
  vcpus,
  policy = DEFAULT_SNP_POLICY,
  runtimeName,
  apiHost = DEFAULT_API,
  fetch,
  onProgress = () => {},
}) {
  onProgress({ phase: 'runtime', detail: 'Resolving the SEV-SNP runtime' })
  const resolved = await resolveInstanceRuntime({ apiHost, name: runtimeName, fetch })
  onProgress({ phase: 'bundle', detail: `Downloading runtime ${resolved.name}` })
  const runtime = await fetchInstanceRuntime({ itemHash: resolved.itemHash, apiHost, fetch })
  onProgress({ phase: 'measure', detail: 'Computing the launch measurements' })
  return trustedExecution({ wasm, runtime, owner, vcpus, policy })
}

/** The pins an INSTANCE's trusted_execution carries. */
export function pinsOf(tee) {
  const expectedMeasurements = (tee?.measurements ?? [])
    .filter((entry) => entry?.platform === 'sev_snp' && typeof entry?.registers?.launch === 'string')
    .map((entry) => entry.registers.launch)
  if (expectedMeasurements.length === 0) throw new Error('the trusted_execution block pins no SEV-SNP measurements')
  return { expectedMeasurements, expectedPolicy: tee.policy }
}

// Errors that mean "the guest is not answering yet" (the agent starts a few
// seconds after the node reports the VM running), as opposed to a verdict.
const NOT_YET = /closed|timed out|Bad Gateway|WebSocket to .* failed|ECONNREFUSED|ECONNRESET/i
const VERDICT = /rejected|bind|measurement|policy|floor|KDS answered 4|signature|refused the secrets/i

/**
 * Attest the instance through the relay and unlock it: the RA-TLS handshake
 * binds the guest's report to its TLS key and the pins (taken from the
 * `trustedExecution` this browser computed, not from an API answer), both
 * reports are verified against AMD, a fresh nonce proves liveness, then the
 * owner signs the injection of `passphrase` (`sign` is personal_sign).
 */
export async function unlockInstance({
  wasm,
  relayUrl,
  crnHash,
  instanceItemHash,
  trustedExecution: tee,
  passphrase,
  sign,
  attempts = 12,
  delayMs = 10_000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  transport = (url) => websocketTransport(url),
  verify,
  fetch,
  onProgress = () => {},
}) {
  if (!passphrase) throw new Error('unlocking needs the passphrase of the encrypted rootfs')
  const { expectedMeasurements, expectedPolicy } = pinsOf(tee)
  const url = `${relayUrl}${relayUrl.includes('?') ? '&' : '?'}crn=${crnHash}&vm=${instanceItemHash}`
  let attested = null
  for (let attempt = 1; !attested; attempt += 1) {
    onProgress({ phase: 'attest', detail: `Attesting the guest (${attempt}/${attempts})` })
    try {
      attested = await attestGuest({
        wasm,
        transport: transport(url),
        expectedMeasurements,
        expectedPolicy,
        fetch,
        ...(verify ? { verify } : {}),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (VERDICT.test(message) || !NOT_YET.test(message) || attempt >= attempts) throw error
      onProgress({ phase: 'wait', detail: `The guest is not answering yet: ${message}` })
      await sleep(delayMs)
    }
  }
  try {
    onProgress({ phase: 'unlock', detail: 'Sign the unlock in your wallet' })
    const injected = await injectSecrets({ wasm, attested, secrets: { luks_passphrase: passphrase }, sign })
    return {
      injected: injected.injected ?? [],
      measurement: attested.freshVerified.measurement,
      policy: attested.freshVerified.policy,
      launchTcb: attested.freshVerified.launchTcb,
    }
  } finally {
    attested.channel.close()
  }
}
