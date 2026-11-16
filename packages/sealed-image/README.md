# @le-space/sealed-image

An image of one's own on Aleph. A measured builder (an Aleph V-PROGRAM, in
`builder/` of this package's source) holds one public plain image on a
verified volume and seals a copy of it with a passphrase the caller derived.
The caller attests the builder, sends the passphrase once over that attested
channel, fetches the sealed image back in runs over an attest relay (each run
attested anew, resumed where a connection broke off), stores it on Aleph as
its own STORE (with retries over another API node) and waits until Aleph
confirms it.

- `derivePassphrase(root, { label, plainSha256 })`: HKDF-SHA256, one
  passphrase per root key, app label and plain image.
- `buildOnFreshBuilder(...)`: starts a builder from the pinned V-PROGRAM
  content (`@le-space/aleph-vm`'s `runOnFreshVProgram`), builds, uploads, and
  forgets the builder; starts one more when another address claimed the first.
- `buildSealedImage(...)`: the same with a builder that already runs.
- `fetchSealed`, `storeMessage`, `storeOnAleph`, `checkBuilder`, `claimText`.
- `keepPrevious`, `releasePrevious`, `forgettable`, `forgetQueued`,
  `fallbackPatch`: the previous image as the way back until a new one started
  well.
- `builderVolumesToForget`: the guard for forgetting a builder's volumes.
- Limits: `MAX_PLAIN_BYTES` (992 MiB), `MAX_SEALED_BYTES` (1 GiB),
  `PIECE_BYTES`, `RUN_BYTES`, `LANES`, `RUN_TRIES`, `UPLOAD_HOSTS`.

Errors are `SealedImageError` with a `code` (`busy`, `claimed`,
`build-failed`, `piece-missing`, `image-gone`, `upload-refused`,
`upload-broken`, `store-rejected`, `store-pending`, `other-image`, …);
progress is `{ step, data }` with `step` one of `start`, `attest`, `build`,
`fetch`, `sign`, `upload`, `confirm`, and never holds the passphrase. The app
words both.

A sealed image that was fetched but not yet confirmed on Aleph is kept while
the page is open (`keptInThisPage`, or your own `kept`): a second try only
uploads it again.

The builder, its publish workflow and its limits:
[Confidential VMs and sealed images](https://nikrause.github.io/relay-button/docs/reference/sealed-images).
