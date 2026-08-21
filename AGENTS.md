# Notes for agents — relay-button

`README.md` says what this is; the docs site explains how to use it. This
file is the set of facts that are expensive to learn twice.

## Documentation is checked, not trusted

`pnpm docs:check` fails the build when the handbook falls behind the code:
an undocumented prop, a routed HTTP path missing from the rootfs contract, a
quick start claiming which dist-tag is ahead. It exists because an audit found
nine drifts at once, three of them wrong rather than untidy.

Two rules it enforces, both learned the hard way:

- **Proposals belong in the issue tracker.** A reader cannot tell a plan from
  a fact once both render as a docs page, and a stale plan discredits the
  pages around it. A section headed `Implementation Plan` or `Remaining` in a
  reference page fails the check.
- **Never claim which dist-tag is newer.** Releases go out under `next` and
  are promoted to `latest`, so which one leads depends on where a release
  sits in that cycle. Point at `npm view <pkg> dist-tags` instead.

## Releasing

`release-packages` publishes to npm **and** tags and writes the GitHub
release, taking its notes from that version's `ROADMAP.md` section. Add the
roadmap entry before releasing; a version without one fails the run on
purpose, because a release with no notes is how four of them once shipped
invisibly. Run `promote-npm-dist-tag` straight after, or `next` ends up
trailing `latest`.

## Connecting: relay-optional by construction

Measured on 2026-08-21, written down because the wrong version of it was in the
code for months. Tracking issue:
[relay-button#119](https://github.com/NiKrause/relay-button/issues/119).

### The promise

The node stays fully functional **without** a relay. That is a guarantee, not a
default: the checkbox is off, a start without it makes no outbound network call
at all, and no relay is contacted without an explicit choice. Someone using the
app in one room leaves metadata nowhere.

A relay is a second way in, for the case the QR path cannot serve: the other
person is not here to scan anything. It is added, never substituted.

### A relay has to be asked for, and then checked

Ticking the box starts the check immediately, so the answer is measured rather
than assumed. Order matters and is not only about speed:

1. the **baked-in** addresses, probed by ping
2. **only if none answer**, Aleph discovery

That way the app talks to Aleph exactly when the known relays are silent, which
is what keeps the metadata footprint small.

### Which relay can do what

A circuit relay brokers the connection; the data then flows **directly** between
devices — measured at 1.6 s, with the relay used only for signalling. So the
2 min / 128 KB limits in go-peer's `relayv2.DefaultResources()` never bite for
connecting, and would for replication.

The real dividing line is not transport, it is **discovery**:

- **A peer you already know** — from a scanned QR code — needs only a route. Any
  circuit relay does, `uc-go-peer` included.
- **A peer you have to find** needs the relay in the mesh of your gossipsub
  discovery topic. A gossipsub node that has not subscribed to a topic does not
  forward its payloads. `uc-go-peer` subscribes to
  `universal-connectivity-browser-peer-discovery` — a `const` in
  `go-peer/chatroom.go`, not a flag.
- **Data that should be pinned** needs a relay that stores something.
  `uc-go-peer` stores nothing; only `orbitdb-relay` qualifies.

This is why a `uc-go-peer` left two simple-todo browsers at `candidates: 0`. Not
because it cannot form a circuit — it can, reservation in 1.5 s — but because it
was not on their discovery topic. Apps whose topics match it, or which also
subscribe to it, can use it among themselves.

### Do not

- Bake a relay address in and call the result server-free.
- Report "usable network" from any ICE candidate: every device has host
  candidates. Only reflexive ones say anything beyond this network answers.
- Probe several addresses of the same relay at once. libp2p muxes them onto one
  connection and the second ping fails with a stream-limit error that is
  evidence **for** reachability, not against it.

### Where this lands in relay-button

The widget owns the deployment UX; the shared connection dialog belongs in
`@le-space/libp2p-webrtc-qr`'s `qr-intro` element, which already exists for
exactly that reason. Shared is **the dialog**, not the connection stack —
peer lists and status chips stay app-owned.
