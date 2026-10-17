# Confidential start E2E

A confidential start from the widget, in Chromium, against a real SEV-SNP
node ([#169](https://github.com/NiKrause/relay-button/issues/169)). The page
renders the React `SponsorRelayFab` with `confidential` and
`confidentialStart`; `server.mjs` serves it, the manifest for the encrypted
rootfs and the attestation WASM, and runs the attest relay on `/attest`. The
spec injects a test wallet, enters the passphrase, deploys, waits for
"Confidential VM attested and unlocked", then for the relay's bootstrap
registration — which needs the deployment token the widget sends with the
unlock — and cleans up through `@le-space/playwright`.

It spends credits: run it through the *Aleph Confidential Widget E2E*
workflow, which builds an encrypted orbitdb-relay rootfs for the run and
forgets it afterwards.

Locally, with an encrypted rootfs and its passphrase:

```bash
(cd ../attest-wasm && pnpm wasm:build)
E2E_ROOTFS_ITEM_HASH=… E2E_LUKS_PASSPHRASE=… E2E_SSH_PUBLIC_KEY="$(cat ~/.ssh/id_ed25519.pub)" \
  E2E_PRIVATE_KEY=… pnpm run e2e
```
