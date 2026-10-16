// Types for js/instance.mjs (relay-button#169, step 4).

/** The generated WASM module (pkg/ in a browser after `await init()`, pkg-node/ in Node). */
export interface AttestWasm {
  reportInfo(report: Uint8Array, product: string): unknown
  verifyReport(...args: unknown[]): unknown
  detectProduct(report: Uint8Array): string | undefined
  verifyFreshBinding(report: Uint8Array, servedPublicKey: Uint8Array, nonce: Uint8Array): void
  injectSecretPayload(servedPublicKey: Uint8Array, canonicalSecretsJson: string): string
  instanceCmdline(template: string, owner: string): string
  launchMeasurements(ovmf: Uint8Array, kernel: Uint8Array, initrd: Uint8Array, cmdline: string, vcpus: number, cpuModels: string[]): Array<{ vcpuType: string; launch: string }>
  RaTlsSession: new (expectedMeasurements: string[], expectedPolicy?: string | null) => unknown
}

/** `environment.trusted_execution` of an SEV-SNP INSTANCE message. */
export interface SnpTrustedExecution {
  mode: 'sev_snp'
  policy: number
  runtime: string
  measurements: Array<{ platform: 'sev_snp'; registers: { launch: string }; vcpu_type?: string }>
}

export interface ConfidentialProgress {
  phase: 'runtime' | 'bundle' | 'measure' | 'attest' | 'wait' | 'unlock'
  detail: string
}

export function confidentialTrustedExecution(args: {
  wasm: AttestWasm
  owner: string
  vcpus: number
  policy?: number
  runtimeName?: string
  apiHost?: string
  fetch?: typeof fetch
  onProgress?: (progress: ConfidentialProgress) => void
}): Promise<SnpTrustedExecution>

export function pinsOf(tee: SnpTrustedExecution): { expectedMeasurements: string[]; expectedPolicy: number }

export interface UnlockResult {
  injected: string[]
  measurement: string
  policy: string
  launchTcb: { fmc: number | null; bootloader: number; tee: number; snp: number; microcode: number }
}

export function unlockInstance(args: {
  wasm: AttestWasm
  relayUrl: string
  crnHash: string
  instanceItemHash: string
  trustedExecution: SnpTrustedExecution
  passphrase: string
  /** More secrets for the same signed injection, e.g. `authorized_keys`. */
  secrets?: Record<string, string>
  /** EIP-191 personal_sign by the instance owner. */
  sign: (payload: string) => Promise<string>
  attempts?: number
  delayMs?: number
  fetch?: typeof fetch
  onProgress?: (progress: ConfidentialProgress) => void
}): Promise<UnlockResult>
