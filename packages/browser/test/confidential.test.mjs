import test from 'node:test'
import assert from 'node:assert/strict'

import { confidentialTrustedExecution, pinsOf, unlockInstance } from '../dist/index.js'

test('@le-space/browser exposes the confidential deploy steps', async () => {
  assert.equal(typeof confidentialTrustedExecution, 'function')
  assert.equal(typeof unlockInstance, 'function')
  assert.deepEqual(pinsOf({ policy: 196608, measurements: [{ platform: 'sev_snp', registers: { launch: 'ab' }, vcpu_type: 'EPYC-v4' }] }), {
    expectedMeasurements: ['ab'],
    expectedPolicy: 196608,
  })
  await assert.rejects(
    unlockInstance({ wasm: {}, relayUrl: 'wss://r', crnHash: 'c', instanceItemHash: 'a', trustedExecution: { measurements: [{ platform: 'sev_snp', registers: { launch: 'ab' } }] }, passphrase: '', sign: async () => '' }),
    /needs the passphrase/,
  )
})
