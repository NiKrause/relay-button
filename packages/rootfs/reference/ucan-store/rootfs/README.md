# ucan-store Rootfs Runtime

This shared rootfs profile packages the current `ucan-upload-wall` local upload
service into an Aleph guest image.

Runtime shape:

- `80/tcp`: temporary setup endpoint used by deployment tooling before first start
- `443/tcp`: public HTTPS proxy for upload API, `did:web`, revocations, and receipts
- internal `127.0.0.1:8787`: upstream upload API worker from `local-storacha-api`
- internal `127.0.0.1:8788`: bootstrap-policy request guard in front of the upload API

Service identity shape:

- default signer algorithm: `Ed25519`
- signer persistence: `/var/lib/ucan-store/service-ed25519.key`
- explicit DID override: `UCAN_STORE_SERVICE_DID`
- hostname-derived DID fallback: `did:web:<proxy-hostname>`
- no-host fallback: persisted `did:key`

Delegation issuance shape:

- admin endpoint: `POST /admin/delegations`
- policy endpoint: `GET /admin/delegations/policy`
- auth: `Authorization: Bearer $UCAN_STORE_ADMIN_API_TOKEN`
- export format: `m...` multibase base64 UCAN CAR proof string
- chaining: child delegations include the persisted bootstrap root delegation as proof

Service discovery shape:

- public manifest: `GET /.well-known/ucan-store.json`
- alias: `GET /service-manifest.json`
- purpose: expose service DID/origin, PWA origin, allowed capabilities, and
  delegation issuance metadata for a generic domain-bound PWA

The guest publishes metadata for the browser PWA after configuration, including:

- `VITE_UPLOAD_SERVICE_URL`
- `VITE_UPLOAD_SERVICE_DID`
- `VITE_REVOCATION_URL`
- `VITE_REVOCATION_DID`
- `VITE_RECEIPTS_URL`

Not included in this base milestone:

- public Helia/libp2p exposure
- Filecoin/archive publishing glue

Bootstrap package handling in the current guest scaffold:

- the setup endpoint now accepts a canonical `bootstrap_package` JSON object
- the package is persisted on the VM for the running upload service
- guest metadata includes a `bootstrap_validation` summary
- guest metadata now also includes `bootstrap_proof_validation`
- guest metadata now also includes `service_identity`
- guest metadata now also includes `delegation_issuance`
- guest metadata now also includes `service_manifest`
- invalid package shape or runtime mismatches fail metadata publication
- `ucan-store.service` now verifies the persisted package again at startup and
  refuses to keep the upload service running when the package is missing
  (by default), malformed, or inconsistent with the runtime DID/origin
- the upload service now reuses one persisted Ed25519 signer on the VM instead
  of generating a fresh test identity on every boot
- the request guard can now mint long-lived service-to-user delegations when an
  admin bearer token is configured, enforcing:
  - `allowedCapabilities`
  - `spaceDid`
  - `defaultUserDelegationExpiration`
  - `maxUserDelegationExpiration`
- the request guard now also publishes a public runtime manifest that a generic
  PWA can fetch via the service domain without relying on build-time-only
  `VITE_UPLOAD_SERVICE_*` values
- the guest now performs cryptographic verification of the bootstrap root
  delegation with the installed `ucanto` / Storacha packages before the
  service is allowed to stay up
- public requests now pass through a local request guard that only forwards
  UCAN invocations when:
  - the invocation capability `with` matches the configured `spaceDid`
  - the invocation `can` stays inside the configured `allowedCapabilities`
  - the invocation proof tree includes the configured bootstrap root delegation

The current guest still does not expose this issuance flow through
`relay-button` yet, and it still does not provide signed multi-tenant manifest
publication; those remain follow-up steps.
