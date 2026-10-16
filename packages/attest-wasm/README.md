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

`js/ratls.mjs` adds the connection to the guest (step 2 of #169). The TLS
client is rustls in WASM (`RaTlsSession`, RustCrypto provider), sans-IO: the
page carries its records over a transport, in the browser a WebSocket to a
relay that forwards them to the guest's attestation port and sees ciphertext
only.

- `attestGuest({ wasm, transport, product, expectedMeasurements, … })`: the
  handshake checks that the report in the guest's certificate is bound to its
  TLS key (`SHA-384("aleph-attest-tls-key-v1\0" ‖ key)`) and carries a pinned
  measurement and the pinned policy; the certificate report is verified
  against AMD; a fresh report for a random nonce is fetched over the same
  channel, verified against AMD and checked to bind the key and the nonce.
- `injectSecrets({ wasm, attested, secrets, sign })`: the instance owner signs
  (EIP-191 `personal_sign`) `aleph-snp-inject-secret-v1|SHA-384(key)|SHA-256(secrets)`
  and the secrets go over the attested channel to `/confidential/inject-secret`.
- `websocketTransport(url)`: the browser transport.

`js/runtime.mjs` builds the INSTANCE message's `trusted_execution` in the
browser (step 4 of #169), because whoever computes the launch measurements
decides what the owner will later accept:

- `resolveInstanceRuntime()` reads the network's default SNP runtime (or one
  by name) from the `vm-images` aggregate;
- `fetchInstanceRuntime({ itemHash })` downloads its manifest and its bundle
  (about 15 MB), checks the bundle against the manifest's SHA-256, unpacks
  OVMF, kernel and initrd;
- `trustedExecution({ wasm, runtime, owner, vcpus })` fills the boot cmdline
  template for the owner and computes one SEV-SNP launch digest per CPU model
  the runtime declares (`src/measure`: the sev crate's measurement code taking
  bytes instead of file paths, Apache-2.0, see `LICENSE-sev`), giving exactly
  the block Aleph's CLI sends (checked against its dry run for snp-1.2).

Domain tags, report_data constructions and the injection payload follow
aleph-rs `ratls.rs` / `owner_auth.rs` and aleph-vm's agent byte for byte. Not
here yet (#169): the relay itself and the widget.

```bash
pnpm --filter @le-space/attest-wasm wasm:build   # needs rustup target wasm32-unknown-unknown and wasm-bindgen-cli 0.2.129
pnpm --filter @le-space/attest-wasm wasm:test    # cargo tests, the RA-TLS test certificate, then the WASM in Node
```
