---
title: Static sites and custom domains
---

# Static sites and custom domains

`@le-space/node` publishes a static directory to IPFS, pins its root CID with
an Aleph `STORE`, and links a custom domain through the Aleph `domains`
aggregate. These are separate operations with a strict readiness boundary:

1. `site-publish` computes a CIDv1/raw-leaves UnixFS DAG and CARv1 locally.
2. It signs a credit-paid STORE for that exact root.
3. CAR and STORE metadata are uploaded together to the authenticated CCN
   `/api/v0/ipfs/add_car` endpoint, matching `aleph-rs`.
4. The returned server root must match the local CAR root; after `processed`,
   the direct CID gateway is verified and the `websites` aggregate is updated.
5. `site-domain-link` validates the STORE, changes the aggregate, and can verify
   that the public domain serves the expected CID.

A successful IPFS upload is **not** a successful custom-domain deployment.
The domain target uses the Aleph STORE item hash, not the IPFS CID. Linking a
pending STORE can leave the workflow green while the public domain continues
to serve its previous IPFS root. The safe defaults prevent that state.

## DNS prerequisites

`site-domain-link` changes the Aleph `domains` aggregate. It does not create DNS
records, and a missing record does not fail the job in a useful way: the run is
green, the aggregate is correct, and the domain still does not resolve. Create
these three records **before** the first domain link.

Worked example for `webrtc-qr.le-space.de`:

| Type | Name | Value |
| --- | --- | --- |
| CNAME | `webrtc-qr.le-space.de` | `ipfs.public.aleph.sh` |
| CNAME | `_dnslink.webrtc-qr.le-space.de` | `_dnslink.webrtc-qr.le-space.de.static.public.aleph.sh` |
| TXT | `_control.webrtc-qr.le-space.de` | `0xD139E44669fD96C714F888B6b04Fe5D02D02B4fD` |

The `_dnslink` value embeds the domain itself before appending
`.static.public.aleph.sh`, so it is **not** a constant across sites. Substitute
your own domain in both halves.

The `_control` TXT is the ownership proof. It must hold the EVM address derived
from the `ALEPH_PRIVATE_KEY` that signs the STORE and the aggregate update. A
key rotation means updating this record, and a site published with a different
key than its `_control` record names will not be served.

Verify before running the workflow:

```bash
dig +short CNAME webrtc-qr.le-space.de
# ipfs.public.aleph.sh.

dig +short CNAME _dnslink.webrtc-qr.le-space.de
# _dnslink.webrtc-qr.le-space.de.static.public.aleph.sh.

dig +short TXT _control.webrtc-qr.le-space.de
# "0xD139E44669fD96C714F888B6b04Fe5D02D02B4fD"
```

The Aleph console lists the same three records when you create the domain, and
detects them as soon as they resolve.

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
      - id: publish
        uses: NiKrause/relay-button/.github/actions/aleph-site-publish@main
        with:
          directory: build
          project_dir: ${{ github.workspace }}
          aleph_private_key: ${{ secrets.ALEPH_PRIVATE_KEY }}
          site_ref: my-site
          retention_keep_count: '2'

  link-domain:
    needs: publish
    if: needs.publish.outputs.store_processed == 'true'
    runs-on: ubuntu-latest
    steps:
      - run: npm install --prefix /tmp/relay-button @le-space/node@0.6.22
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

The composite action is the recommended consumer interface. It runs the
`@le-space/node` implementation from the pinned `relay-button` ref and keeps
dependency installation, API fallback, polling, gateway verification, outputs,
and retention behavior in one shared place.

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
| `libp2p_verified` | `true` when every block was fetched over libp2p (`verify: libp2p`) |

## Checking without HTTP gateways

By default the publisher checks a processed STORE with an HTTP request to
`https://<CID>.ipfs.aleph.sh`, and `site-domain-link` requests
`https://<domain>`. Both go through Aleph's public gateway. Two settings do
the same checks without it:

| Setting | Check |
| --- | --- |
| `verify: libp2p` (`ALEPH_SITE_VERIFY=libp2p`) | Fetches every block of the site from the IPFS network over libp2p and compares the blocks with the uploaded CAR |
| `ALEPH_SITE_DOMAIN_VERIFY=dnslink` | Reads the domain's `_dnslink` TXT record and waits until it names the new CID |

The libp2p check starts a standard Helia node from `libp2pDefaults()` and
`createHelia()` with Bitswap and the DHT only: no trustless gateway, no HTTP
gateway routing, no delegated HTTP routing. AutoTLS and UPnP are left out as
well, because a short-lived check needs no certificate and should not open
router ports. One Helia session fetches the whole DAG; the checked sites took
about six seconds.

Before fetching, the check dials Aleph's own IPFS nodes (`ALEPH_IPFS_PEERS` in
`@le-space/node`). They are DHT servers that hold what Aleph pins, so the check
does not depend on the public IPFS bootstrap nodes, which Shipyard stops
operating on 30 September 2026. With those bootstrap nodes refused, each Aleph
node alone was enough to find providers and fetch a pinned site. `libp2p_peers`
(`ALEPH_SITE_LIBP2P_PEERS`) replaces that list, and `libp2p_timeout_ms`
(`ALEPH_SITE_LIBP2P_TIMEOUT_MS`, default 10 minutes) bounds the fetch.

The DNSLink check follows the CNAME of `_dnslink.<domain>` and asks the
nameservers of the target zone directly, so a cached answer from before the
link cannot pass for the new one. `ALEPH_SITE_DNSLINK_WAIT_ATTEMPTS` (60) and
`ALEPH_SITE_DNSLINK_WAIT_DELAY_MS` (5000) set how long it waits.

## Pending STORE behavior

The default is fail-closed. If the STORE does not become processed within
`ALEPH_SITE_ALEPH_MESSAGE_WAIT_ATTEMPTS` attempts, `site-publish` fails and the
domain job must not run. Retry publication later or increase the wait budget.

`ALEPH_SITE_ALLOW_PENDING_STORE=true` permits an accepted but pending STORE to
be returned for an asynchronous, upload-only workflow. It must not be used in
a workflow that subsequently links a custom domain. `site-domain-link` always
requires a processed STORE regardless of that setting.

The default `ALEPH_SITE_UPLOAD_DRIVER=authenticated-car` avoids the retrieval
race inherent in separate Kubo upload and STORE broadcast. Configure CCN
fallbacks as coupled `ALEPH_SITE_ENDPOINT_PAIRS` JSON:

```json
[
  { "ipfsGateway": "https://ipfs-2.aleph.im", "apiHost": "https://api2.aleph.im" },
  { "ipfsGateway": "https://ipfs.aleph.cloud", "apiHost": "https://api.aleph.im" }
]
```

The same signed STORE envelope is reused across endpoint fallback attempts.
`api3.aleph.im` is unsupported and rejected before any request is made.

Set `ALEPH_SITE_UPLOAD_DRIVER=gateway-relay` only for legacy diagnostics.
Legacy gateway and API lists are accepted only with matching lengths. This
prevents unrelated upload and API nodes from being mixed. The locally computed
CID must equal the upload's explicit wrapped-root response before the STORE is
signed. `ALEPH_SITE_STORE_BROADCAST_ATTEMPTS` retries the exact same signed
envelope and item hash.

The authenticated multipart request contains `file=upload.car` and
`metadata={"message":<signed STORE>,"sync":true}`. The signed website STORE
declares Aleph credit payment explicitly. `ALEPH_SITE_NAME` enables the
versioned `websites` aggregate with volume history. Domain linking performs one
partial `domains` update without temporarily detaching the working target.

After STORE processing, the direct CID URL must return HTTP 200, HTML, and an
`etag` equal to the CIDv0 or `X-Ipfs-Roots` containing it. Pass
`ALEPH_SITE_IPFS_CID_V0` to `site-domain-link` to apply the same requirement to
the custom domain. Configure propagation with `ALEPH_SITE_GATEWAY_WAIT_ATTEMPTS`
and `ALEPH_SITE_GATEWAY_WAIT_DELAY_MS`.

The local importer calculates the DAG deterministically; it is not a durable
provider. An ephemeral GitHub-hosted Helia node is normally not publicly
dialable and disappears when the job ends, so it cannot replace the upload.
