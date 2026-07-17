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
    site_ref: my-site
    retention_keep_count: '2'
```

The default endpoint order is `api2.aleph.im` followed by `api.aleph.im`.
`api3.aleph.im` is unsupported and rejected by the shared runner.
