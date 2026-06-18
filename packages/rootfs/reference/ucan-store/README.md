# ucan-store Rootfs Profile

This profile is the shared `relay-button` scaffold for deploying the
`ucan-store` upload service VM that backs the rebranded upload wall.

Current scope:

- shared rootfs contract for the `ucan-store` profile
- required public VM ports for Aleph guest setup plus the proxied upload API
- documented browser/runtime configuration inputs used by the existing PWA
- a prebaked qcow2 scaffold for the current local upload service runtime
- guest-side setup/configure scripts that publish the service URLs and DID back to deployment tooling

Known inputs from the current `ucan-upload-wall` sources:

- Internal upload API process port: `STORACHA_LOCAL_PORT` with default `8787`
- Local WebAuthn origin inputs: `WEBAUTHN_ORIGIN`, `WEBAUTHN_ORIGIN_FALLBACKS`
- Browser upload-service wiring:
  - `VITE_UPLOAD_SERVICE_URL`
  - `VITE_UPLOAD_SERVICE_DID`
  - `VITE_REVOCATION_URL`
  - `VITE_REVOCATION_DID`
  - `VITE_RECEIPTS_URL`
- Optional direct Helia test wiring:
  - `VITE_HELIA_PEER_ID`
  - `VITE_HELIA_ADDRS`

What is not implemented yet in this shared profile:

- a fixed public Helia/libp2p listener contract for direct IPFS fetches
- long-lived admin/service delegation issuance on the guest
- a stable custom `did:web` service identity derived from the deployed hostname
- service-specific Aleph VM workflow glue for admin DID handoff in `relay-button`
