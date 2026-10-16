// The trusted_execution block of an SEV-SNP INSTANCE message, built in the
// browser (relay-button#169, step 4): the runtime manifest and bundle come
// from Aleph, the bundle is checked against the manifest's SHA-256, and the
// launch measurements are computed here (WASM) for the deploying owner, as
// Aleph's CLI does. A helper that computed them could pin anything.

export const VM_IMAGES_ADDRESS = '0xFba561a84A537fCaa567bb7A2257e7142701ae2A'
export const DEFAULT_SNP_POLICY = 0x30000
const DEFAULT_API = 'https://api2.aleph.im'
const DEFAULT_IPFS = 'https://ipfs.aleph.im/ipfs'

const hex = (bytes) => Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')

/** The item hash of the runtime the network names as default (or `name`, e.g. "snp-1.2"). */
export async function resolveInstanceRuntime({ apiHost = DEFAULT_API, name, fetch: fetchImpl = globalThis.fetch } = {}) {
  const response = await fetchImpl(`${apiHost}/api/v0/aggregates/${VM_IMAGES_ADDRESS}.json?keys=vm-images`)
  if (!response.ok) throw new Error(`vm-images aggregate answered ${response.status}`)
  const images = (await response.json()).data?.['vm-images'] ?? {}
  const key = name ?? images.defaults?.instance_runtime
  const entry = images.instance_runtimes?.[key]
  if (!entry?.hash) throw new Error(`no instance runtime ${JSON.stringify(key)} in vm-images`)
  return { name: key, itemHash: entry.hash, deprecated: entry.deprecated === true }
}

/** The file a STORE message references. */
export async function fetchStoreBytes({ apiHost = DEFAULT_API, ipfsGateway = DEFAULT_IPFS, itemHash, fetch: fetchImpl = globalThis.fetch }) {
  const message = await (await fetchImpl(`${apiHost}/api/v0/messages/${itemHash}`)).json()
  const content = message.message?.content ?? message.content
  if ((message.message?.type ?? message.type) !== 'STORE' || !content?.item_hash) throw new Error(`${itemHash} is not a STORE message`)
  const url = content.item_type === 'ipfs' ? `${ipfsGateway}/${content.item_hash}` : `${apiHost}/api/v0/storage/raw/${content.item_hash}`
  const response = await fetchImpl(url)
  if (!response.ok) throw new Error(`fetching ${itemHash} answered ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

/** The members of a ustar archive, by name. */
export function untar(bytes) {
  const files = new Map()
  const decoder = new TextDecoder()
  for (let offset = 0; offset + 512 <= bytes.length; ) {
    const header = bytes.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const field = (start, length) => decoder.decode(header.subarray(start, start + length)).replace(/\0.*$/s, '').trim()
    const prefix = field(345, 155)
    const name = (prefix ? `${prefix}/` : '') + field(0, 100)
    const size = parseInt(field(124, 12) || '0', 8)
    const type = field(156, 1)
    const start = offset + 512
    if (type === '' || type === '0') files.set(name.replace(/^\.\//, ''), bytes.subarray(start, start + size))
    offset = start + Math.ceil(size / 512) * 512
  }
  return files
}

async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** The runtime manifest and its bundle's OVMF, kernel and initrd, checked against the manifest. */
export async function fetchInstanceRuntime({ itemHash, apiHost, ipfsGateway, fetch }) {
  const manifest = JSON.parse(new TextDecoder().decode(await fetchStoreBytes({ apiHost, ipfsGateway, itemHash, fetch })))
  if (manifest.format !== 'aleph-instance-runtime' || manifest.platform !== 'sev_snp') {
    throw new Error(`${itemHash} is not an SEV-SNP instance runtime manifest`)
  }
  const bundle = await fetchStoreBytes({ apiHost, ipfsGateway, itemHash: manifest.bundle.ref, fetch })
  const digest = hex(await globalThis.crypto.subtle.digest('SHA-256', bundle))
  if (digest !== manifest.bundle.sha256 || (manifest.bundle.size && bundle.length !== manifest.bundle.size)) {
    throw new Error(`the runtime bundle does not match its manifest (sha256 ${digest})`)
  }
  const files = untar(await gunzip(bundle))
  const member = (role) => {
    const data = files.get(manifest.bundle.members[role])
    if (!data) throw new Error(`the runtime bundle has no ${role} (${manifest.bundle.members[role]})`)
    return data
  }
  return { itemHash, manifest, ovmf: member('ovmf'), kernel: member('kernel'), initrd: member('initrd') }
}

/**
 * `environment.trusted_execution` for an SEV-SNP instance owned by `owner`
 * with `vcpus` vCPUs, in the shape Aleph's CLI sends (and @le-space/core's
 * TrustedExecution type describes).
 */
export function trustedExecution({ wasm, runtime, owner, vcpus, policy = DEFAULT_SNP_POLICY }) {
  const cmdline = wasm.instanceCmdline(runtime.manifest.boot.cmdline_template, owner)
  const measurements = wasm.launchMeasurements(runtime.ovmf, runtime.kernel, runtime.initrd, cmdline, vcpus, runtime.manifest.boot.cpu_models)
  return {
    mode: 'sev_snp',
    policy,
    runtime: runtime.itemHash,
    measurements: measurements.map(({ vcpuType, launch }) => ({ platform: 'sev_snp', registers: { launch }, vcpu_type: vcpuType })),
  }
}
