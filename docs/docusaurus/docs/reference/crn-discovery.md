# CRN discovery: crns.json and the corechannel aggregate

Every deploy starts with the same question: *which compute node (CRN) should
host this VM?* Relay Button can answer it from two sources. This page explains
what each one knows, which is used when, and why the more decentralized of the
two is deliberately **not** the default.

## The two sources

| | `crns.json` (`crns-list.aleph.sh`) | `corechannel` aggregate |
| --- | --- | --- |
| What it is | A service that continuously polls every registered CRN and publishes a snapshot | The on-chain registry every CRN registers itself in — an Aleph aggregate under `0xa1B3bb7d2332383D96b7796B908fB7f7F3c2Be10` |
| Served by | One host, one origin | Every Aleph API host (`api2.aleph.im`, `api.aleph.im`, …) |
| Node identity, address, score | yes | yes (`score`, falling back to `scoreV1`) |
| Registration state | implied (inactive nodes filtered) | `status`, `parent`, `inactive_since`, `locked` |
| **`qemu_support`** | yes | **no** |
| **`system_usage`** (free CPU / RAM / disk) | yes | **no** |
| **Liveness** | yes — the whole point of the service | **no** — registration is not aliveness |
| Geo fields | sometimes pre-filled | never |

The aggregate is the ground truth `crns.json` is *derived* from. That makes it
the right fallback, but it is a registry, not a health check: a node can be
`linked` and correctly registered while being switched off, full, or unable to
run QEMU instances at all.

## Which one is used

**`crns.json` is the default. The aggregate is the fallback.**

The candidate list is read by `fetchCrnsWithSource()` in
`@le-space/core` (`packages/core/src/crns.ts`), which:

1. requests `crns.json`;
2. falls back to the aggregate if that request **fails** *or* **returns an
   empty list** — an empty candidate set is just as useless to a deploy as a
   502;
3. walks the configured Aleph API hosts in order until one serves the
   aggregate;
4. reports which source it used, so the deploy log names it.

The fallback exists because `crns-list.aleph.sh` was the one centralized hop in
an otherwise decentralized deploy path. When it served `502` for over an hour,
deploys died with it even though the Aleph API hosts stayed healthy. In the
browser that outage does not even look like an outage: the gateway's error page
carries no `Access-Control-Allow-Origin` header, so the UI reports a CORS
failure rather than a `502`.

## Why the aggregate is not the default

This is the honest trade-off, and it is not about trust or decentralization —
it is about the two fields the aggregate cannot carry.

**`qemu_support`.** Instance deploys need QEMU. A node that does not support it
can never host the VM, but it looks perfectly healthy in the registry. Without
this flag we hand such a node a full allocation attempt before finding out.

**`system_usage`.** `filterDeployableCrns()` uses free CPU, memory and disk to
drop nodes that cannot fit the requested `vcpus` / `memoryMiB` / `diskMiB`
*before* any request is sent. Without it, a full node is indistinguishable from
an idle one until it answers `503 Insufficient capacity` — and each such
mistake costs a failover cycle measured in minutes, not seconds.

Both fields are simply absent on aggregate-sourced records rather than `false`,
which `filterDeployableCrns()` already treats as "unknown, keep" — so nothing
is wrongly rejected. But "keep" is not "verified": the filter goes from
*informed* to *permissive*.

So defaulting to the aggregate would trade a **rare** outage for a
**permanent** rise in failed first attempts. The fallback buys the resilience
without paying that cost on every healthy day.

## The reachability probe

The aggregate has no liveness signal, so when candidates come from it, the
GitHub Actions deploy path verifies them itself. `filterReachableCrns()` asks
each candidate for `GET /about/executions/list` — trying `/v2/…` first, then
the v1 route — and drops the ones that do not answer. This is step 4 of the
original proposal and overlaps with the faster-failover work in
`NiKrause/relay-button#83`.

Three details worth knowing:

- Only the **head** of the ranking is probed (`max_crn_attempts × 2`).
  Failover walks the ordered tail anyway, and probing every registered node
  would cost more than it saves.
- A non-404 answer counts as alive. The node is clearly serving requests; only
  a missing route justifies falling back to the v1 path.
- If **nothing** answers, the unverified ranking is kept rather than failing
  the run. A runner that cannot reach CRNs directly should still get to try.

The probe replaces some of what `crns.json` polling gave us, but not all of it:
it proves a node is *answering*, not that it has capacity or QEMU support.
That is why it is a safety net for the fallback, not a reason to prefer it.

### Browser asymmetry

The browser client falls back to the aggregate but does **not** probe. It reads
the aggregate from the same `apiHosts` it already uses, then relies on its
existing behavior: the user sees the CRN picker, and a rejected
`/control/allocation/notify` fails the attempt and advances to the next
candidate (see [Deployment paths](./deployment-paths.md)). Probing every
candidate up front would put N extra round-trips on the critical path before
the picker can render. Worth revisiting if aggregate-sourced deploys turn out
to pick dead nodes often in practice.

## Forcing the aggregate

Set `crn_source: aggregate` on the deploy action (or `ALEPH_VM_CRN_SOURCE=aggregate`)
to skip `crns.json` entirely. The default, `auto`, prefers it for the live
capacity data described above.

```yaml
- uses: NiKrause/relay-button/.github/actions/aleph-vm-deploy@main
  with:
    crn_source: aggregate
```

Reasonable uses: reproducing a deploy that must not depend on a centralized
service, testing the fallback path itself, or riding out a `crns.json` outage
that returns wrong data rather than failing outright — the one failure mode the
automatic fallback cannot detect.

## What would make the aggregate a safe default

Nothing here is permanent. The default flips the moment the capacity gap
closes, for example if:

- CRNs expose QEMU support and free capacity on an endpoint the probe already
  hits, so one round-trip recovers both fields; or
- the corechannel aggregate itself grows those fields; or
- the deploy path gets cheap enough failover (503 fast-fail, a per-deployer
  failure ledger with cooldown) that a wrong first pick stops being expensive.

Until then, `crns.json` stays the preferred source and the aggregate keeps the
deploy path alive when it is not there.
