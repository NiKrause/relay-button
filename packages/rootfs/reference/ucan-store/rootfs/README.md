# ucan-store Rootfs Runtime

This shared rootfs profile packages the current `ucan-upload-wall` local upload
service into an Aleph guest image.

Runtime shape:

- `80/tcp`: temporary setup endpoint used by deployment tooling before first start
- `443/tcp`: public HTTPS proxy for upload API, `did:web`, revocations, and receipts
- internal `127.0.0.1:8787`: upstream upload API worker from `local-storacha-api`
- internal `127.0.0.1:8788`: bootstrap-policy request guard in front of the upload API

The guest publishes metadata for the browser PWA after configuration, including:

- `VITE_UPLOAD_SERVICE_URL`
- `VITE_UPLOAD_SERVICE_DID`
- `VITE_REVOCATION_URL`
- `VITE_REVOCATION_DID`
- `VITE_RECEIPTS_URL`

Not included in this base milestone:

- public Helia/libp2p exposure
- Filecoin/archive publishing glue
- service-side delegation issuance from an admin DID

Bootstrap package handling in the current guest scaffold:

- the setup endpoint now accepts a canonical `bootstrap_package` JSON object
- the package is persisted on the VM for the running upload service
- guest metadata includes a `bootstrap_validation` summary
- guest metadata now also includes `bootstrap_proof_validation`
- invalid package shape or runtime mismatches fail metadata publication
- `ucan-store.service` now verifies the persisted package again at startup and
  refuses to keep the upload service running when the package is missing
  (by default), malformed, or inconsistent with the runtime DID/origin
- the guest now performs cryptographic verification of the bootstrap root
  delegation with the installed `ucanto` / Storacha packages before the
  service is allowed to stay up
- public requests now pass through a local request guard that only forwards
  UCAN invocations when:
  - the invocation capability `with` matches the configured `spaceDid`
  - the invocation `can` stays inside the configured `allowedCapabilities`
  - the invocation proof tree includes the configured bootstrap root delegation

Current validation is structural and consistency-oriented. Full cryptographic
runtime enforcement of bootstrap policy on every incoming invocation is still a
follow-up step for the upload-service implementation.
