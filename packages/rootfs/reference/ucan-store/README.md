# ucan-store Rootfs Profile

This profile is the shared `relay-button` scaffold for deploying the
`ucan-store` upload service VM that backs the rebranded upload wall.

Current scope:

- shared rootfs contract for the `ucan-store` profile
- required public VM ports for Aleph guest setup plus the proxied upload API
- documented browser/runtime configuration inputs used by the existing PWA
- a prebaked qcow2 scaffold for the current local upload service runtime
- guest-side setup/configure scripts that publish the service URLs and DID back to deployment tooling
- stable guest-side service signer persistence with an Ed25519 default and hostname-aware DID selection
- a guest-side request guard that narrows public UCAN invocations to the configured bootstrap envelope
- a guest-side admin delegation issuance API that can mint importable child delegations from the service DID
- a public service manifest endpoint for domain-first runtime discovery by a generic PWA

Known inputs from the current `ucan-upload-wall` sources:

- Internal upload API process port: `STORACHA_LOCAL_PORT` with default `8787`
- Internal bootstrap-policy request guard port: `UCAN_STORE_PROXY_PORT` with default `8788`
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
- service-specific Aleph VM workflow glue for full bootstrap-package collection in `relay-button`

Current bootstrap-package support in this shared profile:

- canonical JSON bootstrap package shape accepted by the shared node deploy runner
- guest-side storage of the bootstrap package on the VM
- guest-side structural validation for:
  - `operatorAddress`
  - `adminDid`
  - optional `serviceDid`
  - `spaceDid`
  - `rootDelegationProof`
  - `allowedCapabilities`
  - delegation expiration policy
  - `pwaOrigin`
  - `serviceOrigin`
- runtime consistency checks that compare:
  - bootstrap `serviceDid` against the running service DID when provided
  - bootstrap `serviceOrigin` against the configured public upload-service origin
- `ucan-store.service` startup gating that:
  - requires a bootstrap package by default
  - re-validates the package before the service stays up
  - probes the live `did:web` document and rejects startup on DID/origin mismatches
- stable service identity handling that:
  - persists one Ed25519 signer on the VM under `/var/lib/ucan-store`
  - reuses that signer across restarts instead of generating a fresh test key
  - prefers an explicit `UCAN_STORE_SERVICE_DID` override when configured
  - otherwise derives `did:web:<proxy-hostname>` once a public hostname is assigned
  - otherwise falls back to the persisted signer `did:key`
- cryptographic bootstrap proof verification that checks:
  - root delegation signature
  - root delegation issuer against `adminDid`
  - root delegation audience against the configured service DID
  - delegation lifetime (`nbf` / `exp`)
  - coverage of the configured `allowedCapabilities` for the configured `spaceDid`
- request-time public invocation narrowing that rejects:
  - capabilities outside the configured `allowedCapabilities`
  - requests for a different `spaceDid`
  - invocation proof trees that do not include the configured bootstrap root delegation
- service-side user delegation issuance that:
  - uses the persisted service signer as issuer
  - chains back to the stored root bootstrap delegation
  - exports a CAR-backed `m...` proof string the current UI can import directly
  - enforces configured capability and expiration policy
  - can be protected with `UCAN_STORE_ADMIN_API_TOKEN`
- public service discovery metadata that:
  - is exposed at `/.well-known/ucan-store.json`
  - has a `/service-manifest.json` alias
  - surfaces service DID/origin, PWA origin, allowed capabilities, and
    delegation issuance metadata for runtime binding

This still does not emit protocol-native UCAN error receipts from the guard
layer yet; rejected requests currently fail at HTTP level before they reach the
underlying upload API.
