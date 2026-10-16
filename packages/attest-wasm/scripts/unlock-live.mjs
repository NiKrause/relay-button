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
import { unlockInstance } from '../js/instance.mjs'

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

const result = await unlockInstance({
  wasm,
  relayUrl: url,
  crnHash: crn,
  instanceItemHash: vm,
  // The script reads the pins back from the message; the widget passes the
  // block it computed itself.
  trustedExecution: content.environment.trusted_execution,
  passphrase,
  sign: (payload) => owner.signMessage(payload),
  onProgress: ({ phase, detail }) => {
    console.error(`${phase}: ${detail}`)
    if (phase === 'unlock') mark('attested')
  },
})
mark('unlocked')
close()
console.log(JSON.stringify({ result: { injected: result.injected }, measurement: result.measurement, policy: result.policy, launchTcb: result.launchTcb, timings }))
