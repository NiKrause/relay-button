#!/usr/bin/env node
// Attest and unlock a real confidential instance the way the browser will
// (relay-button#169): the RA-TLS client in WASM, over a WebSocket through the
// attest relay, the AMD chain checked against KDS, the measurements and policy
// taken from the INSTANCE message, the injection signed by the owner key.
//
//   ALEPH_PRIVATE_KEY=… node scripts/unlock-live.mjs <instance item hash> <node hash> \
//     <passphrase file> [relay ws url, default: an in-process relay]
//
// Needs pkg-node (pnpm wasm:build). Prints the phase timings as JSON.

import { readFile } from 'node:fs/promises'
import http from 'node:http'
import { createRequire } from 'node:module'

import { Wallet } from 'ethers'
import { attachAttestRelay, resolveAttestationTarget } from '@le-space/attest-relay'

import { pinnedMeasurements } from '../js/index.mjs'
import { attestGuest, injectSecrets, websocketTransport } from '../js/ratls.mjs'

const require = createRequire(import.meta.url)
const wasm = require('../pkg-node/relay_button_attest.js')
const API = process.env.ALEPH_API_HOST ?? 'https://api2.aleph.im'

const [vm, crn, passphraseFile, relayUrl] = process.argv.slice(2)
if (!/^[0-9a-f]{64}$/.test(vm ?? '') || !/^[0-9a-f]{64}$/.test(crn ?? '') || !passphraseFile) {
  console.error('usage: unlock-live.mjs <instance item hash> <node hash> <passphrase file> [relay ws url]')
  process.exit(2)
}
const owner = new Wallet(process.env.ALEPH_PRIVATE_KEY)
const passphrase = (await readFile(passphraseFile, 'utf8')).replace(/\r?\n$/, '')
const started = Date.now()
const timings = []
const mark = (phase) => timings.push({ phase, ms: Date.now() - started })

const message = await (await fetch(`${API}/api/v0/messages/${vm}`)).json()
const content = message.message?.content ?? message.content
const expectedMeasurements = pinnedMeasurements(content)
const expectedPolicy = content?.environment?.trusted_execution?.policy
if (expectedMeasurements.length === 0) throw new Error('the INSTANCE message pins no SEV-SNP measurements')
mark('message')

let close = () => {}
let url = relayUrl
if (!url) {
  const server = http.createServer()
  const relay = attachAttestRelay(server, {
    resolveTarget: (c, v) => resolveAttestationTarget({ crn: c, vm: v, fetch: globalThis.fetch, apiHost: API }),
    log: (line) => console.error(line),
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  url = `ws://127.0.0.1:${server.address().port}/attest`
  close = () => {
    relay.close()
    server.closeAllConnections()
    server.close()
  }
}

let attested = null
for (let attempt = 1; attempt <= 12 && !attested; attempt += 1) {
  try {
    attested = await attestGuest({
      wasm,
      transport: websocketTransport(`${url}?crn=${crn}&vm=${vm}`),
      expectedMeasurements,
      expectedPolicy,
    })
  } catch (error) {
    // The agent needs a moment after the node starts the VM; a refused
    // attestation (chain, TCB, binding, pins) is final.
    if (!/closed|failed|timed out|Bad Gateway|refused/i.test(error.message) || /rejected|bind|measurement|policy|floor|KDS/i.test(error.message)) throw error
    console.error(`attempt ${attempt}: ${error.message}`)
    await new Promise((resolve) => setTimeout(resolve, 10_000))
  }
}
if (!attested) throw new Error('the guest did not answer')
mark('attested')
console.error(`attested: measurement=${attested.freshVerified.measurement} policy=${attested.freshVerified.policy}`)

const result = await injectSecrets({ wasm, attested, secrets: { luks_passphrase: passphrase }, sign: (payload) => owner.signMessage(payload) })
mark('unlocked')
attested.channel.close()
close()
console.log(JSON.stringify({ result, measurement: attested.freshVerified.measurement, policy: attested.freshVerified.policy, launchTcb: attested.freshVerified.launchTcb, timings }))
