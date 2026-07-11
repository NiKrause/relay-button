---
title: Static sites and custom domains
---

# Static sites and custom domains

`@le-space/node` publishes a static directory to IPFS, pins its root CID with
an Aleph `STORE`, and links a custom domain through the Aleph `domains`
aggregate. These are separate operations with a strict readiness boundary:

1. `site-publish` computes the wrapped UnixFS directory CID locally.
2. It uploads the same ordered files and requires the returned root to match.
3. The upload and STORE use one endpoint pair (by default `ipfs-2` + `api2`).
4. One signed STORE envelope is reused for transient retries; after `processed`,
   the direct CID gateway is verified.
5. `site-domain-link` validates the STORE, changes the aggregate, and can verify
   that the public domain serves the expected CID.

A successful IPFS upload is **not** a successful custom-domain deployment.
The domain target uses the Aleph STORE item hash, not the IPFS CID. Linking a
pending STORE can leave the workflow green while the public domain continues
to serve its previous IPFS root. The safe defaults prevent that state.

## GitHub Actions example

```yaml
jobs:
  publish:
    runs-on: ubuntu-latest
    outputs:
      item_hash: ${{ steps.publish.outputs.item_hash }}
      ipfs_cid_v0: ${{ steps.publish.outputs.ipfs_cid_v0 }}
      store_processed: ${{ steps.publish.outputs.store_processed }}
    steps:
      - uses: actions/checkout@v6
      - run: npm install --prefix /tmp/relay-button @le-space/node@0.6.20
      - id: publish
        env:
          ALEPH_VM_MODE: site-publish
          ALEPH_SITE_DIRECTORY: ${{ github.workspace }}/build
          ALEPH_SITE_PIN: 'true'
          ALEPH_SITE_REF: my-site
          ALEPH_PRIVATE_KEY: ${{ secrets.ALEPH_PRIVATE_KEY }}
        run: >-
          node --input-type=module -e
          "import('/tmp/relay-button/node_modules/@le-space/node/index.js')
          .then((module) => module.runSiteMode())"

  link-domain:
    needs: publish
    if: needs.publish.outputs.store_processed == 'true'
    runs-on: ubuntu-latest
    steps:
      - run: npm install --prefix /tmp/relay-button @le-space/node@0.6.20
      - env:
          ALEPH_VM_MODE: site-domain-link
          ALEPH_SITE_ITEM_HASH: ${{ needs.publish.outputs.item_hash }}
          ALEPH_SITE_IPFS_CID_V0: ${{ needs.publish.outputs.ipfs_cid_v0 }}
          ALEPH_SITE_DOMAIN: app.example.com
          ALEPH_SITE_DOMAIN_CATCH_ALL_PATH: /index.html
          ALEPH_PRIVATE_KEY: ${{ secrets.ALEPH_PRIVATE_KEY }}
        run: >-
          node --input-type=module -e
          "import('/tmp/relay-button/node_modules/@le-space/node/index.js')
          .then((module) => module.runSiteMode())"
```

The `if` condition documents the dependency in the workflow. The domain-link
runner still performs its own STORE check, so bypassing the condition cannot
link a pending target.

## Outputs

`site-publish` emits:

| Output | Meaning |
| --- | --- |
| `ipfs_cid_v0` | Root CID used by the Aleph STORE |
| `ipfs_cid_v1` | Browser/gateway-friendly form of the root CID |
| `url` | Direct Aleph IPFS gateway URL |
| `item_hash` | Aleph STORE message hash; this is the domain target |
| `store_status` | `processed`, `pending`, or `not-requested` |
| `store_processed` | `true` only when the STORE is safe to link |

## Pending STORE behavior

The default is fail-closed. If the STORE does not become processed within
`ALEPH_SITE_ALEPH_MESSAGE_WAIT_ATTEMPTS` attempts, `site-publish` fails and the
domain job must not run. Retry publication later or increase the wait budget.

`ALEPH_SITE_ALLOW_PENDING_STORE=true` permits an accepted but pending STORE to
be returned for an asynchronous, upload-only workflow. It must not be used in
a workflow that subsequently links a custom domain. `site-domain-link` always
requires a processed STORE regardless of that setting.

Configure fallbacks as coupled `ALEPH_SITE_ENDPOINT_PAIRS` JSON:

```json
[{ "ipfsGateway": "https://ipfs-2.aleph.im", "apiHost": "https://api2.aleph.im" }]
```

Legacy gateway and API lists are accepted only with matching lengths. This
prevents unrelated upload and API nodes from being mixed. The locally computed
CID must equal the upload's explicit wrapped-root response before the STORE is
signed. `ALEPH_SITE_STORE_BROADCAST_ATTEMPTS` retries the exact same signed
envelope and item hash.

After STORE processing, the direct CID URL must return HTTP 200, HTML, and an
`etag` equal to the CIDv0 or `X-Ipfs-Roots` containing it. Pass
`ALEPH_SITE_IPFS_CID_V0` to `site-domain-link` to apply the same requirement to
the custom domain. Configure propagation with `ALEPH_SITE_GATEWAY_WAIT_ATTEMPTS`
and `ALEPH_SITE_GATEWAY_WAIT_DELAY_MS`.

The local importer calculates the DAG deterministically; it is not a durable
provider. An ephemeral GitHub-hosted Helia node is normally not publicly
dialable and disappears when the job ends, so it cannot replace the upload.
