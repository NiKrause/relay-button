# @le-space/node

Node-specific adapters, CLI entrypoints, environment parsing, and GitHub output
helpers will live here.

## Site Publish Helper

`runSiteMode(...)` supports static site publishing, domain linking, browser
bootstrap env generation, and relay probing. The site publish and relay probe
paths are implemented directly in Node so consumer workflows do not need
repo-local helper scripts for those stages.

### Safe custom-domain sequence

Run `site-publish` before `site-domain-link`. With pinning enabled, publication
only succeeds after the Aleph STORE is `processed`; it emits `item_hash`,
`store_status=processed`, and `store_processed=true`. Domain linking validates
the STORE again before changing the `domains` aggregate. A pending or rejected
STORE therefore cannot silently replace a working domain target.

`ALEPH_SITE_ALLOW_PENDING_STORE=true` is an explicit escape hatch for
asynchronous publication workflows that do **not** link a custom domain. Never
enable it in a publish-and-link pipeline.

See the Docusaurus page “Static sites and custom domains” for a complete GitHub
Actions example and the environment-variable contract.
