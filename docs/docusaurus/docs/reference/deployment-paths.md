# Deployment paths: Browser UI vs. GitHub Actions

Relay Button ships two independent ways to provision an Aleph relay VM. Both
share the low-level building blocks in `@le-space/core` (instance message
creation, CRN scoring/notify, runtime inspection, FORGET/erase), but the
orchestration differs substantially — which explains why the Actions path has
historically been more reliable than the browser path.

| Aspect | Browser (`@le-space/ui` controller + `@le-space/browser`) | GitHub Actions (`@le-space/node` `deploy-executor`) |
| --- | --- | --- |
| Signing | MetaMask `personal_sign` per message (user interaction) | `ALEPH_PRIVATE_KEY` (non-interactive) |
| CRN selection | `filterDeployableCrns` (score-sorted crns-list snapshot), preferred CRN first, up to 5 candidates | Same scoring plus geo preference, `manual`/`scheduler` placement strategies, `vm_max_crn_attempts` |
| Allocation notify | Result was **discarded** until 0.6.32; now an unconfirmed notify fails the attempt and triggers CRN failover | Result still discarded (`.catch(() => null)`) — compensated by the runtime wait below |
| Runtime validation | `waitForVmRuntime` polls CRN for IPv4/ports | Same, but failure cleanly advances to the next CRN candidate |
| Guest configuration | HTTP `POST VM:80/configure`; failure degrades to a warning | `waitForSetupEndpoint` (hard gate) then `configureOrbitdbRelaySetup`; failure fails the attempt |
| Bootstrap registration | Waits for the guest; on delay **publishes a browser fallback registration and then reports "Relay ready"** — a dead guest looks green | Reads real metadata (peer id, multiaddrs) from the configured VM, publishes an owner-authorized registration, verifies visibility on Aleph |
| Reachability validation | None — no dial test before success | **Required relay probes** (`tcp`, `proxy-wss`; best-effort `webrtc-direct`) — success means the relay was actually dialed |
| Cleanup of failed attempts | Erase + FORGET + verify (since 0.6.30/0.6.32 fixes) | Erase + FORGET + verify, plus retention of the last N successful deployments |

## Sequence: Browser path (Sponsor Relay UI)

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant UI as SponsorRelayController<br/>(@le-space/ui)
    participant MM as MetaMask
    participant API as Aleph API (api2/api)
    participant CRN as CRN (scored candidate)
    participant VM as Relay VM (guest)

    User->>UI: Deploy Relay
    loop up to 5 CRN candidates
        UI->>MM: personal_sign(INSTANCE message)
        UI->>API: publish INSTANCE (+ port-forward aggregate)
        UI->>CRN: POST /control/allocation/notify
        alt notify rejected (e.g. 503 "cannot host")
            Note over UI,CRN: since 0.6.32: attempt fails →<br/>erase + FORGET + next candidate
        else notify confirmed
            UI->>CRN: poll runtime (IPv4, mapped ports)
            UI->>VM: POST :80/configure (registration id, keys)
            VM-->>API: guest publishes bootstrap registration<br/>(refresh service, relay:profile:name)
            UI->>API: poll for guest registration
            alt guest delayed / dead
                UI->>API: publish browser-fallback registration
                Note over UI: ⚠ then reports "Relay ready" —<br/>fallback must not count as success
            end
        end
    end
    UI-->>User: panel status (success/error)
```

## Sequence: GitHub Actions path (deploy-executor)

```mermaid
sequenceDiagram
    autonumber
    participant GH as GitHub Action<br/>(@le-space/node deploy-executor)
    participant API as Aleph API (api2/api)
    participant CRN as CRN candidate
    participant VM as Relay VM (guest)

    loop up to vm_max_crn_attempts candidates<br/>(manual or scheduler placement)
        GH->>API: publish INSTANCE (key-signed)
        GH->>API: wait until message processed
        GH->>CRN: POST /control/allocation/notify (result ignored ⚠)
        GH->>CRN: waitForVmRuntime (IPv4, mapped ports)
        alt runtime never ready
            GH->>CRN: erase + FORGET failed attempt
            Note over GH: next CRN candidate
        else runtime ready
            GH->>VM: waitForSetupEndpoint (:80, hard gate)
            GH->>VM: POST /configure (orbitdb relay setup)
            VM-->>GH: metadata (peer id, real multiaddrs)
            GH->>API: publish owner-authorized bootstrap registration
            GH->>API: verify registration visible
            GH->>VM: relay probes — tcp + proxy-wss required
            Note over GH,VM: success only after real dials succeed
        end
    end
```

## Why the Actions path "just works" more often

1. **No success lie.** The Actions path derives the bootstrap registration
   from metadata served by the configured VM itself and then dials the relay
   (`tcp`, `proxy-wss` required). The browser path can publish a predicted
   fallback registration for a VM that never booted and still report
   "Relay ready" (observed in simple-todo E2E runs #37–#42).
2. **Hard gates instead of warnings.** `waitForSetupEndpoint` and a failed
   `/configure` abort the attempt in the Actions path; the browser treats the
   equivalent situations as recoverable warnings.
3. **Failover maturity.** `vm_max_crn_attempts` existed in the Actions path
   long before the browser gained working failover in 0.6.32 (the browser
   discarded the allocation-notify result until then, so a full CRN —
   NodeCity3 at capacity, HTTP 503 — silently produced ghost deployments).

## Known gaps (both paths)

- `notifyCrnAllocationWithRetry` results are still ignored in
  `deploy-executor` (`.catch(() => null)`); the runtime wait compensates, but
  adopting the 0.6.32 browser behavior (fail the attempt on an unconfirmed
  notify) would save one full runtime-wait cycle per rejected CRN.
- The browser fallback registration should never satisfy the "Relay ready"
  condition; consumers (e.g. the simple-todo E2E guard) currently have to
  detect it themselves via the publisher address.
- Neither path health-checks a CRN before selecting it; a CRN with broken
  Aleph endpoints (e.g. responses referencing retired `official.aleph.cloud`
  hosts) is only discovered after a deploy attempt.
