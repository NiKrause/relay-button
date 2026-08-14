# Roadmap

## 0.9.0 — CRN discovery without a single point of failure

The deploy path no longer dies with `crns-list.aleph.sh` (#92). When that
service fails or returns nothing, both the Actions and the browser path read
the CRN candidates from the `corechannel` aggregate instead — the on-chain
registry `crns.json` is itself derived from, served by every Aleph API host.
In the browser the outage did not even look like one: the gateway's 502 page
carries no CORS header, so the UI reported a CORS failure.

The aggregate carries no liveness signal, so aggregate-sourced candidates are
probed against `GET /about/executions/list` before they cost a deployment
attempt — partial credit on #83. The browser probe distinguishes a dead node
from a request that never arrived, keeping candidates whose failure is our
own origin's problem.

`crns.json` stays the default: it is the only source carrying `qemu_support`
and free capacity, and defaulting to the aggregate would trade a rare outage
for a permanent rise in failed first attempts. The reasoning, and what would
change it, is written up in
[CRN discovery](docs/docusaurus/docs/reference/crn-discovery.md).

Minor rather than patch because this adds public surface: new exported
functions and types in `@le-space/core` and `@le-space/browser`, a new client
method, a new `crnSource` prop and state field, a new `crn_source` action
input, and a new `DeployPlan` field.

The source is selectable on every surface — `crn_source` /
`ALEPH_VM_CRN_SOURCE` for Actions, the `crnSource` prop for the widget, and
`localStorage.LE_SPACE_CRN_SOURCE` as a runtime switch so the fallback can be
exercised against the real network without a rebuild.

Gated on manual testing of the widget in both consumer repos (simple-todo and
universal-connectivity `js-peer`) against `0.9.0@next` before promotion to
`latest`, same as 0.8.0.

## Shipped: 0.8.0 — deployment addresses on the card

The deployment card gains Multiaddresses and Health tabs (#96): each
deployment shows the addresses its own endpoint reports, grouped by
transport, every row individually copyable. Nothing is ranked — the card
shows what the relay said rather than computing a "best" address, which is
why it is unaffected by the `best.websocket` defect in #93/#94.

`uc-go-peer` now answers `/multiaddrs` and `/describe` through its HTTPS
proxy, making that one path across the libp2p profiles. The React build gains
its first clipboard affordance.

Gated on manual testing of the widget in both consumer repos (simple-todo and
universal-connectivity `js-peer`) against `0.8.0@next` before promotion to
`latest`, same as 0.7.0.

Not covered: `ucan-store`'s address document, and the four data-quality
findings against `orbitdb-relay` listed in #96.

## Shipped: 0.7.0 — Relay Button branding

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
