// The test page: the React widget with confidential starts set up, nothing
// else. server.mjs serves it with /config.json and the attest relay on /attest.
import React from 'react'
import { createRoot } from 'react-dom/client'

import { SponsorRelayFab } from '../ui/src/react/index.ts'
import { attestGuest, websocketTransport } from '../attest-wasm/js/ratls.mjs'

const config = await (await fetch('/config.json')).json()
const relayUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/attest`

async function loadWasm() {
  const wasm = await import('/pkg/relay_button_attest.js')
  await wasm.default()
  return wasm
}

// For the spec: attest an instance again through another attest relay (the
// one the new orbitdb-relay serves at /attest), with the same pins.
;(window as unknown as Record<string, unknown>).__e2eReattest = async (args: {
  relayUrl: string
  crnHash: string
  instanceItemHash: string
  measurement: string
  policy: string | number
}) => {
  const wasm = await loadWasm()
  const url = `${args.relayUrl}?crn=${args.crnHash}&vm=${args.instanceItemHash}`
  const attested = await attestGuest({
    wasm,
    transport: websocketTransport(url),
    expectedMeasurements: [args.measurement],
    expectedPolicy: args.policy,
  })
  attested.channel.close()
  return attested.freshVerified.measurement as string
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <SponsorRelayFab
    // The controller traces each step to the console; the spec reads them.
    debug
    manifestJson={JSON.stringify(config.manifest)}
    crnSource="aggregate"
    confidential
    confidentialStart={{
      rootfsItemHash: config.manifest.rootfsItemHash,
      rootfsSizeMiB: config.manifest.rootfsSizeMiB,
      relayUrl,
      loadWasm,
    }}
    showInstances
  />,
)
