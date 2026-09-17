# Aleph Site Publish

This composite action exposes the shared `@le-space/node` static-site publisher
without requiring consumer repositories to duplicate dependency installation,
environment mapping, STORE polling, gateway verification, or retention logic.

```yaml
- id: publish
  uses: NiKrause/relay-button/.github/actions/aleph-site-publish@main
  with:
    directory: dist
    project_dir: ${{ github.workspace }}
    aleph_private_key: ${{ secrets.ALEPH_PRIVATE_KEY }}
    site_name: my-site
```

Every publish adds a STORE message, and Aleph bills each one for as long as it
is kept. With `site_name` set, the action keeps the newest
`retention_keep_count` uploads of that site (3 by default) and forgets the
older ones. It never forgets an upload that a domain or website still points
to. `retention_keep_count: '0'` keeps every upload. `site_ref` is no longer
used.

Set `verify: libp2p` to check the processed site by fetching every block over
libp2p with Helia instead of requesting it from Aleph's HTTP gateway.

The default endpoint order is `api2.aleph.im` followed by `api.aleph.im`.
`api3.aleph.im` is unsupported and rejected by the shared runner.
