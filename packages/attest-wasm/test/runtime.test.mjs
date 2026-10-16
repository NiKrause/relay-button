import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

import { fetchInstanceRuntime, resolveInstanceRuntime, trustedExecution, untar } from '../js/runtime.mjs'

const require = createRequire(import.meta.url)
const wasm = require('../pkg-node/relay_button_attest.js')

test('untar reads ustar members', () => {
  const header = new Uint8Array(512)
  const put = (text, at) => header.set(new TextEncoder().encode(text), at)
  put('image/a.txt', 0)
  put('00000000005\0', 124)
  put('0', 156)
  put('ustar', 257)
  const body = new Uint8Array(512)
  body.set(new TextEncoder().encode('hello'))
  const files = untar(new Uint8Array([...header, ...body, ...new Uint8Array(1024)]))
  assert.equal(new TextDecoder().decode(files.get('image/a.txt')), 'hello')
})

test('instanceCmdline fills the owner slot, lowercased', () => {
  assert.equal(
    wasm.instanceCmdline('console=ttyS0 luks=1 owner={owner}', '0x28129bdDa64310221480d4eF903446b0cdFD4BEb'),
    'console=ttyS0 luks=1 owner=0x28129bdda64310221480d4ef903446b0cdfd4beb',
  )
  assert.throws(() => wasm.instanceCmdline('console=ttyS0', '0x28129bdDa64310221480d4eF903446b0cdFD4BEb'), /no \{owner\} slot/)
})

// Downloads the 15 MB snp-1.2 bundle from Aleph; CI sets LIVE_RUNTIME=1.
test('trusted_execution for snp-1.2 matches what Aleph\'s CLI pinned', { skip: process.env.LIVE_RUNTIME !== '1', timeout: 180_000 }, async () => {
  const { itemHash } = await resolveInstanceRuntime({ name: 'snp-1.2' })
  assert.equal(itemHash, '5cd480a138c5969b18d1f6850a5fe0176e6f22e65a323ad9593e71165fb687bc')
  const runtime = await fetchInstanceRuntime({ itemHash })
  const tee = trustedExecution({ wasm, runtime, owner: '0x28129bdDa64310221480d4eF903446b0cdFD4BEb', vcpus: 1 })
  // The CLI's `instance create --dry-run` for this owner, 1 vCPU, snp-1.2.
  assert.deepEqual(tee, {
    mode: 'sev_snp',
    policy: 196608,
    runtime: '5cd480a138c5969b18d1f6850a5fe0176e6f22e65a323ad9593e71165fb687bc',
    measurements: [
      { platform: 'sev_snp', registers: { launch: 'ef01e41042b1333a3cd96a925c82d90c8381b131185dee8ec3022c1a1b05ba581d85f9a08b9578e885704e6ecff29de8' }, vcpu_type: 'EPYC-Genoa' },
      { platform: 'sev_snp', registers: { launch: '32683e52cb6cc93dbf37e86f7891546d75ec0c64e5e96ed718e2e62ebc4d0d9f5353d97aa41ef8daf1909a3dc4e20361' }, vcpu_type: 'EPYC-v4' },
    ],
  })
})
