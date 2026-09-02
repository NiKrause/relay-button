# Roadmap

## 0.9.8 — a relay publishes its websocket address the moment it has one

A relay refreshes its bootstrap registration on a timer: once about twenty
minutes after boot, then every six hours. AutoTLS issues the certificate on
its own schedule. Nothing connected the two. A certificate that arrived after
that first refresh sat unpublished for up to six hours.

Measured on the live relay 65.108.233.158: booted 07:02:24, AutoTLS ready
07:04:14, registration refreshed 07:30:27, next refresh 13:36. A relay
deployed three and a half hours earlier had published two webtransport
addresses and one webrtc-direct, and no websocket at all, because it had none
to publish when its turn came.

That set cannot be verified by the thing that consumes it.
`select_compact_multiaddrs` keeps the three best browser-dialable addresses,
ranking proxy wss first, AutoTLS wss second, webtransport and webrtc-direct
after. With neither of the top two ranks available, all three slots go to
transports Node cannot dial, and js-peer's `bootstrap:resolve` — which proves
a peer is alive by connecting to it over a websocket — reports "no
Node-dialable address proved this peer is live" and refuses to bake a list it
could not verify.

Both relay profiles now start their bootstrap refresh from the AutoTLS
refresh's `ExecStartPost`. `--no-block` is not optional: both units are
`Type=oneshot`, and starting one synchronously from inside the other's
`ExecStartPost` deadlocks systemd. `ucan-store` is deliberately untouched —
its AutoTLS unit is a `/bin/true` placeholder and it has no periodic refresh
to trigger.

How thin the margin was: a run at 07:50 discovered six relays and exactly one
of them offered a websocket address that answered. One other had a proxy
address whose host no longer connects. The build that depends on these relays
was passing on the health of a single peer.

## 0.9.7 — the relay's websocket address points at a port that is open

Four of the five address families a uc-go-peer relay announces used the port
Aleph published it on. The AutoTLS websocket used the port the relay binds
inside the guest. Measured on the live relay `65.108.233.158`: 9097 filtered
from the internet, 24013 open, both the same listener — and 9097 was the one
being advertised.

Browsers discard an address they cannot reach, so the published registration
carried no wss entry at all. The `direct-wss` probe family then had nothing to
try, its required probe failed, and `bootstrap:resolve` in js-peer refused to
bake a bootstrap list it could not verify. One wrong port number, and the
build that consumes these relays could not go green.

`uc-go-peer-configure.sh` had translated the port correctly all along. The
address is rewritten a second time by the AutoTLS refresh, which waits for the
certificate, scans the journal for the concrete SNI hostname, and re-emitted
the matched log line verbatim — carrying the internal port back out with it.
It only ever looked right because the log is where the true hostname is.

`orbitdb-relay` reads `EXTERNAL_RELAY_WS_PORT` and raises when it is missing,
which is why its relays have always published a reachable wss address and
uc-go-peer's never did. The two profiles now agree, though uc-go-peer falls
back to the backend port with a line on stderr rather than refusing to boot.

The logic sat inside `main()`, between a `journalctl` call and a `systemctl
restart`, where no test could reach it — which is the reason it survived this
long. It now lives in two pure functions, and three of the six tests covering
them fail against the previous release.

Also: a stale `.pyc` had been committed before `__pycache__` was ignored, so
every published tarball shipped bytecode for a script it no longer matched.

## 0.9.6 — the guest can be asked what it is waiting for

A relay deployed from universal-connectivity sat idle for hours: the relay
process dead, the setup endpoint alive on port 80, and a journal containing
one line — "Started uc-go-peer-bootstrap.service". Nothing else, in five
hours.

That silence is the release. The setup servers had no logging at all, their
HTTP handlers silenced their own, and every failure path swallowed its
exception. So a guest that never found its locator, one whose aggregate query
returned 404, one handed a record it could not use, and one nobody ever asked
to do anything all produced the same empty journal. "The relay VM did not
confirm that it applied the Aleph bootstrap config" was therefore not a
diagnosis — it was the only thing anyone could say. Both `uc-go-peer` and
`orbitdb-relay` now say which of those four states they are in, once per state
rather than every five seconds (#133).

Also in this release, the security overrides that had been stuck on a
conflicting branch since 23 July: esbuild, dompurify, js-yaml,
webpack-dev-server, http-proxy-middleware, brace-expansion, ws and eight more
move to patched versions. The branch was rebuilt rather than merged — its
lockfile had diverged 800 lines against a tree that has since moved through
five releases (#132).

**For universal-connectivity:** this is the version its rootfs builder needs.
It pins `@le-space/node` at 0.9.0, so every image it has built since carries
none of the diagnostics above — including the browser-side ones from 0.9.5.
Raising that pin is what makes the next failed deployment explain itself.

## 0.9.5 — two failures that could not be read, and one that could not be seen

A deployment from universal-connectivity failed on all five compatible CRNs
and said, five times over, `[object Object]`. The nodes were fine — all five
answered `/about/executions/list` with HTTP 200 — and so was the rootfs the
manifest pointed at, and the credit balance. One systemic cause, repeated five
times, and the widget threw the only description of it away:
`new Error(String(error))` on a rejection that was an object rather than an
`Error`, which is what an Aleph or CRN response rejected as `{ code, message }`
is. `describeThrown` now takes the message the thrower meant to send, follows
the `cause` chain to the request that actually failed, and falls back to a
truncated dump rather than to nothing (#127).

Discovery could be blinded by a single record it did not like. The reader
ended with `posts.forEach(assertSupportedRelayBootstrapPost)`, so one legacy
v1 post threw and took the whole page with it. The bootstrap channel is public
and append-only: the offending record belongs to somebody else, nobody can
FORGET it, and every consumer polls the same page — so that would have been a
permanent blackout for all of them. This is the failure aleph-rs hit in
production on 2026-08-30, where a page-strict message iterator left the
scheduler unable to see new v-programs at all; their answer was to yield per
item and carry on, and this is ours. Unusable records are skipped and reported
through `onUnsupportedPost` (#128).

And this release publishes itself. A merged "Cut" already bumps every package
and writes the section these notes come from, but publishing still waited for
somebody to dispatch a workflow and untick a `dry_run` that defaults to true.
Nobody did, twice, for 0.9.4. A push to main now publishes exactly when it
changed the version — under `next` only, because promotion to `latest` has
been gated on manual testing since 0.7.0 and 0.9.2 is the argument for keeping
that gate (#129).

**Before promoting to `latest`:** exercise the relay button in
universal-connectivity's `js-peer` once it is on this version. That app is
still on 0.9.0, which is where the unreadable failure was reported from, and
it is the consumer this release exists for.

## 0.9.4 — the drag nobody could do, and the scope nobody could ask for

0.9.2 shipped a draggable launcher and said so. In the Svelte build it did not
work at all: `initPlacement()` sat behind `await controller.init()`, so
`placement` stayed null for as long as Aleph took to answer the manifest and
instance queries — and `handleDragStart` returns early on a null placement.
Measured in simple-todo: still immovable twenty seconds after the app was
ready, with `pointerdown`, eight `pointermove`s and `pointerup` all arriving at
the button. Placement needs no network; it reads storage and the viewport. It
now runs first.

The React build never had this — it resolves placement in its own effect,
which is also why the defect survived: the two builds disagreed and nothing
compared them.

Also in this release, and the reason the number is 0.9.4 rather than 0.9.3:
`@le-space/aleph-bootstrap` can be scoped by `registrationId` (#121), so a
consumer sees its own registrations rather than the whole channel — its own
erased E2E relays included, which is what left a browser probe wave spending
its stream budget on corpses. That work landed after 0.9.3 had already been
published from this repo, so it has never been on npm. Publishing the set at
0.9.4 is what gets it there and keeps every package on one number.

That is the point of the other half. `RelayButtonDriver` gains
`dragLauncherBy`, `tapLauncherWithWobble` and `launcherBox` (#117), so a
consumer verifies a drag without rebuilding the pointer sequence against
behaviour that is not its own — the ~6 px threshold, the clamping, a storage
that throws. The 0.9.2 notes asked for a manual check before promoting to
`latest`; that check never happened, and it would have failed. This replaces
it with one that runs.

## 0.9.2 — a relay button the user can move out of the way

The launcher and the panel each positioned themselves with hardcoded corner
offsets, so a consumer could not place either (#113). Wrapping the launcher
does not help and the failure is instructive: it is `position: fixed`, so it is
out of flow, so the wrapper collapses to 0×0 — no box to position, none to
drag. That left `:global()` against private class names. On a phone the button
sat on top of content with no way out.

Three additive props: `position` picks a starting corner, `draggable` lets the
user move it, `positionStorageKey` remembers where they put it. Defaults leave
the render unchanged.

The panel now follows the launcher. It was never "above the button" — it was
`bottom: 11.5rem` next to the launcher's `5.8rem`, two constants that happened
to agree, so anything moving one would have separated them. It anchors to the
measured launcher and flips its open direction near an edge.

Patch rather than minor on purpose. It adds exports, but a caret range on a 0.x
version locks the minor, so `^0.9.1` picks up 0.9.2 and would *not* pick up
0.10.0 — shipping the fix as a patch is what gets it to consumers without a
bump PR in each of them.

Also in this release, from the docs audit: a quick start that told readers to
install a build from July, an HTTP surface (`/multiaddrs`, `/describe`) that no
page defined, first reference pages for `@le-space/core` and
`@le-space/browser`, proposals moved out of the reference and into the tracker,
and a `docs:check` CI job that fails when the docs fall behind the code.

**Before promoting to `latest`:** exercise the drag by hand in simple-todo.
The geometry has unit tests, but real pointer input has no harness in this
package.

## 0.9.1 — a cleanup that stops failing on something it never owned

`cleanupRelay` waited for the relay's bootstrap registration to be
deregistered and threw when it was not — a wait that could never succeed
(#103). A relay publishes its own `relay-bootstrap-v2` POST signed with the
*relay's* key, and Aleph honours a FORGET only from the original sender, so
the account running cleanup was never able to forget it. `cleanupRelay` did
not put the registration in its own FORGET either, so even a registration the
account did own stayed unforgotten and the wait stayed unreachable. Erasing
the VM also denies the relay the graceful shutdown in which it would
deregister itself. Every cleanup therefore burned the full timeout and threw.

The sender is now resolved first. A registration this account cannot forget is
skipped with the reason reported, because it is not a cleanup failure and
nothing about it bills; one the account does own is added to the FORGET *and*
waited for, so the wait can succeed. An unreadable sender is skipped and kept
out of the FORGET — an unowned hash makes Aleph reject the whole request,
which would take the INSTANCE cleanup down with it and leave a billing VM.

Downstream this is what kept NiKrause/simple-todo's "Relay button E2E"
permanently red while every functional assertion in it passed: provisioning
and two-browser replication succeeded, and only the teardown reported failure.

Also: the Multiaddresses and Health tabs share one `/multiaddrs` request, so a
single transport failure blanked both and left Chrome's raw "signal is aborted
without reason" on screen, naming neither the timeout nor the far more common
real cause (#102).

**Note for whoever publishes this.** `release-packages` defaults to
`npm_tag: next`, so 0.8.0 and 0.9.0 went out under `next` and the `latest`
dist-tag still points at 0.7.0 — a plain `npm i @le-space/playwright` installs
a version from July. Run `promote-npm-dist-tag` after this release.

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
