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
