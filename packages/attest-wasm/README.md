# @le-space/attest-wasm

SEV-SNP attestation verification that runs **in the browser**, so a person
deploying a confidential Aleph instance from the widget can check the guest
themselves before anything secret is sent to it (relay-button#169).

The verifier is aleph-rs's (`crates/aleph-sdk/src/attest`, v0.22.0, MIT; see
`LICENSE-aleph-rs` and the header of each file in `src/attest/`), trimmed to
what a browser can run:

- no network or file access: the caller fetches the VCEK and the product CRL
  from AMD's KDS, which answers with `Access-Control-Allow-Origin: *`;
- pure-Rust crypto: `sev` with `crypto_nossl`, and the `rsa` crate instead of
  `ring` for AMD's RSASSA-PSS CRL signature, so it builds for
  `wasm32-unknown-unknown` without a C toolchain.

`verifyReport` checks the AMD ARK → ASK → VCEK chain, the report signature,
revocation, the TCB floor (AMD's published SB-3019 baseline, raised by an
optional network floor), and then that the launch measurement is one the
INSTANCE message pinned and the guest policy is the pinned one.
`js/index.mjs` wraps it: `verifyAttestation({ wasm, report, product,
expectedMeasurements, expectedPolicy, minTcb })` fetches the certificates and
verifies.

Not here yet (see #169): the RA-TLS client that takes the report out of the
guest's TLS certificate over a WebSocket relay, and the secret injection.

```bash
pnpm --filter @le-space/attest-wasm wasm:build   # needs rustup target wasm32-unknown-unknown and wasm-bindgen-cli 0.2.129
pnpm --filter @le-space/attest-wasm wasm:test    # cargo tests (aleph-rs's and ours) + the WASM in Node
```
