# @le-space/node

Node-specific adapters, CLI entrypoints, environment parsing, and GitHub output
helpers will live here.

## Site Publish Helper

`runSiteMode(...)` supports static site publishing and domain linking. The
publish path shells out to `packages/node/reference/publish-static-site.py`,
which expects these Python dependencies:

```bash
python3 -m pip install -r packages/node/reference/requirements-site-publish.txt
python3 -m pip install aleph-client
```

Consumer workflows should install from that shared requirements file instead of
hardcoding Python package names in each repository.
