# Roadmap

## 0.7.0 — Relay Button branding

First release shipping the new brand system (#80): Le-Space palette,
JetBrains Mono/Inter typography, brand-lockup launcher, re-themed Svelte +
React widgets and Docusaurus theme.

Gated on manual testing of the widget in both consumer repos
(simple-todo `main`/`collab01` and universal-connectivity `js-peer`)
against `0.7.0@next` before promotion to `latest`. Also folds in the
`package-version.ts` staleness fix so the docs version badge stays
truthful.

Tracking issue with the full checklist and release flow:
[#81](https://github.com/NiKrause/relay-button/issues/81)

## Shipped

- **0.6.41 / 0.6.42** — fresh-relay browser dialability hardening for
  `orbitdb-relay` and `uc-go-peer` (symmetric certificate gate, registration
  publish retry). See the
  [dialability timeline](docs/docusaurus/docs/reference/relay-dialability-timeline.md)
  and the release notes of
  [v0.6.41](https://github.com/NiKrause/relay-button/releases/tag/v0.6.41) /
  [v0.6.42](https://github.com/NiKrause/relay-button/releases/tag/v0.6.42).
- **0.6.37–0.6.40** — HTTPS-origin deploys via guest config pull over Aleph
  aggregates, no-secrets-over-HTTP guard, browser-dialable-address invariant
  with CRN failover.
