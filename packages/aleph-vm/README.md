# @le-space/aleph-vm

Start, attest and forget confidential VMs on Aleph from the browser or Node,
signed by an app's own key on behalf of the account that pays.

- **INSTANCE** (a confidential VM with an encrypted rootfs): `instanceMessage`,
  `send`, `forwardPorts`, `notifyNode`, `publicAddress`, `nodeState`,
  `forgetInstance`, `eraseOnNode`, `listInstances`, `ownInstance` /
  `checkOwnInstance` (an INSTANCE this key signed, checked by content hash and
  signature), `credits`, `estimateCreditsPerHour`, `crnAddress`, `hostname`,
  `validHost`, `twoN6Host`.
- **V-PROGRAM** started for one piece of work and forgotten after it:
  `runOnFreshVProgram`, `vprogramMessage`, `forgetVProgram`, `checkTemplate`,
  `templateMismatches`.
- **Attested channel** through an attest relay: `attestedOpener` (RA-TLS with
  `@le-space/attest-wasm`, the measurements and policy pinned, the relay that
  worked last first), `callJson`, `refusedAttestation`, `relayHost`.
- **Aleph API**: `broadcast` (waits until processed, also when the
  synchronous answer never comes), `poster`, `readFetch` (retries a hiccup),
  `messageStatus`, `sha256Hex`.

`app` is anything with `address` and `signMessage({ message })`, e.g. a viem
local account. Every message carries `address` = payer and is sent by the
app's key, which the payer authorized. Nothing here loads WASM, holds a key or
shows text: errors are `AlephVmError` with a `code` (`unreachable`,
`refused`, `no-template`, `no-relay`, `not-ours`, …).

```js
import { attestedOpener, runOnFreshVProgram } from '@le-space/aleph-vm'

const result = await runOnFreshVProgram({
  app, channel: 'my-app', template, // { program, crn, measurements, policy }
  opener: (running) => attestedOpener(running, loadAttest),
  work: async ({ open }) => {
    const channel = await open() // attested
    return channel.request('GET', '/')
  },
  onStarted: (vprogram) => note(vprogram), // forgotten afterwards, whatever happened
  onForgotten: () => clear()
})
```

How it fits together with `@le-space/sealed-image`:
[Confidential VMs and sealed images](https://nikrause.github.io/relay-button/docs/reference/sealed-images).
