# ucan-store Rootfs Runtime

This shared rootfs profile packages the current `ucan-upload-wall` local upload
service into an Aleph guest image.

Runtime shape:

- `80/tcp`: temporary setup endpoint used by deployment tooling before first start
- `443/tcp`: public HTTPS proxy for upload API, `did:web`, revocations, and receipts
- internal `127.0.0.1:8787`: upstream upload API worker from `local-storacha-api`

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
- invalid package shape or runtime mismatches fail metadata publication
- `ucan-store.service` now verifies the persisted package again at startup and
  refuses to keep the upload service running when the package is missing
  (by default), malformed, or inconsistent with the runtime DID/origin

Current validation is structural and consistency-oriented. Full cryptographic
validation of the root UCAN delegation proof still belongs in the actual
upload-service implementation.
