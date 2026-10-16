// The test page: the React widget with confidential starts set up, nothing
// else. server.mjs serves it with /config.json and the attest relay on /attest.
import React from 'react'
import { createRoot } from 'react-dom/client'

import { SponsorRelayFab } from '../ui/src/react/index.ts'

const config = await (await fetch('/config.json')).json()
const relayUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/attest`

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
      loadWasm: async () => {
        const wasm = await import('/pkg/relay_button_attest.js')
        await wasm.default()
        return wasm
      },
    }}
    showInstances
  />,
)
