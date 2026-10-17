import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

import { pinsOf, unlockInstance } from '../js/instance.mjs'
import { agent, measurement, owner, tcpTransport } from './helpers.mjs'

const require = createRequire(import.meta.url)
const wasm = require('../pkg-node/relay_button_attest.js')

const CRN = 'c'.repeat(64)
const VM = 'a'.repeat(64)
const tee = { mode: 'sev_snp', policy: undefined, runtime: 'r'.repeat(64), measurements: [{ platform: 'sev_snp', registers: { launch: measurement }, vcpu_type: 'EPYC-v4' }] }
// The AMD chain is stubbed here (wasm.test.mjs covers it).
const verify = async () => ({ verified: true, measurement, policy: '0x30000', launchTcb: { bootloader: 12 } })

test('pinsOf takes the SEV-SNP launch digests and the policy', () => {
  assert.deepEqual(pinsOf({ policy: 196608, measurements: [{ platform: 'sev_snp', registers: { launch: 'aa' } }, { platform: 'tdx', registers: { mrtd: 'bb' } }] }), {
    expectedMeasurements: ['aa'],
    expectedPolicy: 196608,
  })
  assert.throws(() => pinsOf({ measurements: [] }), /pins no SEV-SNP measurements/)
})

test('unlockInstance waits for the guest to answer, attests with the local pins, unlocks', async () => {
  const guest = await agent()
  const urls = []
  const waits = []
  let calls = 0
  const result = await unlockInstance({
    wasm,
    relayUrl: 'wss://relay.example/attest',
    crnHash: CRN,
    instanceItemHash: VM,
    trustedExecution: tee,
    passphrase: 'correct horse',
    secrets: { authorized_keys: 'ssh-ed25519 AAAA aleph-bootstrap-config:0x0:token\n' },
    sign: (payload) => owner.signMessage(payload),
    verify,
    sleep: async (ms) => waits.push(ms),
    // First the agent is not up yet (the relay closes), then it answers.
    transport: (url) => {
      urls.push(url)
      calls += 1
      if (calls === 1) return { opened: Promise.reject(new Error('WebSocket to wss://relay.example failed')), send() {}, onData() {}, onClose() {}, close() {} }
      return tcpTransport(guest.port)
    },
  })
  assert.deepEqual(result.measurement, measurement)
  assert.deepEqual([...guest.injected].sort(), ['authorized_keys', 'luks_passphrase'])
  assert.equal(urls[0], `wss://relay.example/attest?crn=${CRN}&vm=${VM}`)
  assert.deepEqual(waits, [10_000])
  guest.close()
})

test('unlockInstance does not retry a verdict', async () => {
  const guest = await agent()
  let calls = 0
  await assert.rejects(
    unlockInstance({
      wasm,
      relayUrl: 'wss://relay.example/attest',
      crnHash: CRN,
      instanceItemHash: VM,
      trustedExecution: { ...tee, measurements: [{ platform: 'sev_snp', registers: { launch: '11'.repeat(48) } }] },
      passphrase: 'x',
      sign: (payload) => owner.signMessage(payload),
      verify,
      sleep: async () => assert.fail('a verdict must not be retried'),
      transport: () => (calls += 1, tcpTransport(guest.port)),
    }),
    /rejected during the RA-TLS handshake: measurement/,
  )
  assert.equal(calls, 1)
  guest.close()
})

test('unlockInstance refuses to run without a passphrase', async () => {
  await assert.rejects(unlockInstance({ wasm, relayUrl: 'wss://r', crnHash: CRN, instanceItemHash: VM, trustedExecution: tee, passphrase: '', sign: async () => '' }), /needs the passphrase/)
  await assert.rejects(unlockInstance({ wasm, relayUrl: 'wss://r', crnHash: CRN, instanceItemHash: VM, trustedExecution: tee, passphrase: 'x', secrets: { luks_passphrase: 'y' }, sign: async () => '' }), /not in secrets/)
})
