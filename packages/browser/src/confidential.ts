// Confidential (AMD SEV-SNP) deploys from the browser (relay-button#169):
// the trusted_execution block for the INSTANCE message, computed here for the
// owner, and the attest-then-unlock through the attest relay once the node
// runs the instance. The work is @le-space/attest-wasm's (WASM verifier,
// RA-TLS client, launch measurement); the WASM module is passed in, so a host
// app decides how it loads it.

export {
  confidentialTrustedExecution,
  pinsOf,
  unlockInstance,
} from '@le-space/attest-wasm/instance'
export type {
  AttestWasm,
  ConfidentialProgress,
  SnpTrustedExecution,
  UnlockResult,
} from '@le-space/attest-wasm/instance'
