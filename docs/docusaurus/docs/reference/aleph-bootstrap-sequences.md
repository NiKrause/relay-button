# Aleph Bootstrap Sequences

This page ties together the real implementation paths across:

- the browser Sponsor Relay UI
- the guest VM bootstrap publisher
- the reusable UC rootfs workflow
- the shared `@le-space/node` deploy and site runners

It is meant as a visual map for the parts that are easiest to lose track of:

1. who owns bootstrap publication at runtime
2. when CRN allocation and runtime checks happen
3. how the workflow, guest, and browser hand off responsibility

## Browser To Guest Bootstrap Ownership

The current target behavior is guest-owned runtime bootstrap publication.

The browser still orchestrates the deployment and waits for confirmation, but
the `uc-go-peer` handoff is now a multi-phase flow:

1. wait for usable runtime networking
2. wait for `2n6` activation when proxy-backed HTTPS is possible
3. publish `vm-bootstrap-config` into Aleph
4. wait for the guest config signal
5. confirm secure relay metadata
6. wait for the guest bootstrap registration
7. publish a browser fallback only when the guest registration stays delayed

```mermaid
sequenceDiagram
  autonumber
  participant Browser as SponsorRelayFab / browser controller
  participant Wallet as Owner wallet
  participant Aleph as Aleph API
  participant CRN as Scheduler / CRN
  participant VM as Guest VM
  participant Relay as uc-go-peer / orbitdb-relay-pinner
  participant Registry as Aleph bootstrap POST registry
  participant App as js-peer / browser libp2p app

  Browser->>Aleph: load manifest, pricing, balance, CRNs
  Browser->>Wallet: sign deploy intent and Aleph INSTANCE payload
  Browser->>Aleph: broadcast INSTANCE message
  Aleph-->>Browser: pending / processed deployment status
  Browser->>CRN: notify selected CRN allocation
  Browser->>Aleph: poll deployment result and runtime details
  Aleph-->>Browser: processed + mapped ports + host IP / proxy URL + guest IPv6

  alt proxy-backed HTTPS is possible
    Browser->>Aleph: wait for active 2n6 route
    Aleph-->>Browser: https://relay-name.2n6.me active
    Browser->>Aleph: publish vm-bootstrap-config aggregate with active proxyUrl
  else proxy route stays inactive after waiting
    Browser->>Aleph: publish vm-bootstrap-config aggregate without proxyUrl
  else guest IPv6 is not public
    Note over Browser,Aleph: A non-public guest IPv6 is treated as unusable for proxy-backed HTTPS.<br/>The browser cleans up that attempt and retries another CRN instead of continuing.
  end

  VM->>Aleph: read vm-bootstrap-config aggregate
  VM->>Relay: start relay with persisted identity and runtime config
  Relay-->>VM: peerId + public multiaddrs + browser-safe multiaddrs
  VM->>Aleph: publish vm-bootstrap-config-status signal

  alt signal already contains relay metadata
    Browser->>Aleph: accept peerId + public multiaddrs from config signal
  else signal is incomplete
    Browser->>VM: poll relay metadata endpoint
    Note over Browser,VM: Prefer https://relay-name.2n6.me/bootstrap/metadata when active.<br/>Otherwise fall back to the temporary setup endpoint.
  end

  VM->>Registry: publish relay-bootstrap POST with guest publisher identity
  Browser->>Registry: wait for guest registration by registrationId + peerId

  alt guest registration is delayed
    Browser->>Registry: publish browser fallback relay-bootstrap POST
    Browser->>Registry: wait for fallback registration visibility
    Note over Browser,Registry: This safety path keeps browser discovery usable even when the guest<br/>registration arrives late.
  end

  Browser->>Aleph: remove temporary vm-bootstrap-config aggregate
  App->>Registry: discover freshest bootstrap records at startup
  Registry-->>App: browserMultiaddrs / public relay multiaddrs
  App->>Relay: dial relay using discovered runtime addresses
```

### What This Means

- The owner wallet is still authoritative for deployment and authorization.
- The guest VM becomes authoritative for the runtime relay address set.
- Discovery clients should trust the newest guest-visible bootstrap state, not
  workflow-baked constants.

## Workflow, CRN, And VM Deployment Sequence

This is the high-level sequence for the UC workflow when a run is started with
`publish=true` and `deploy_vm=true`.

Unlike the browser `uc-go-peer` path, the workflow path still drives guest
configuration through the temporary mapped setup port. It then converges on the
same final bootstrap registration and Aleph visibility checks.

```mermaid
sequenceDiagram
  autonumber
  participant Operator as Workflow operator / dispatcher
  participant Entry as build-aleph-go-peer-rootfs.yml
  participant Reusable as uc-go-peer-rootfs-reusable.yml
  participant RootfsRunner as @le-space/node runRootfsMode
  participant SiteRunner as @le-space/node runSiteMode
  participant Aleph as Aleph API + IPFS pin / STORE
  participant DeployAction as aleph-vm-deploy action
  participant Scheduler as Scheduler / CRN selection
  participant Guest as Guest configure + relay services
  participant Probe as relay-probe runner
  participant Retention as retain-successful-deployments

  Operator->>Entry: workflow_dispatch(publish, deploy_vm, sizing, CRN prefs)
  Entry->>Reusable: call reusable workflow with normalized inputs

  Reusable->>RootfsRunner: rootfs-publish mode
  Note over Reusable,RootfsRunner: build binary, assemble rootfs image,<br/>emit manifest, optionally skip upload when publish=false.
  RootfsRunner->>Aleph: upload qcow2 to IPFS and wait for STORE message
  Aleph-->>RootfsRunner: rootfs CID + Aleph item hash + manifest outputs
  RootfsRunner-->>Reusable: rootfs_version, rootfs_cid, rootfs_item_hash

  opt publish=true
    Reusable->>SiteRunner: site-publish mode for js-peer
    SiteRunner->>Aleph: publish static site and optional Aleph pin
    Aleph-->>SiteRunner: site item hash + site URL
    SiteRunner-->>Reusable: site URL + manifest URLs
  end

  opt publish=true and main domain configured
    Reusable->>SiteRunner: site-domain-link mode
    SiteRunner->>Aleph: link production domain to published site
    Aleph-->>SiteRunner: domain attachment confirmed
  end

  opt deploy_vm=true
    Reusable->>DeployAction: deploy VM from published rootfs
    DeployAction->>Scheduler: rank/select CRN by hash or geo preference
    Scheduler-->>DeployAction: preferred CRN candidate set
    DeployAction->>Aleph: broadcast INSTANCE deployment message
    Aleph-->>DeployAction: pending / processed message status
    DeployAction->>Scheduler: notify selected CRN allocation
    DeployAction->>Aleph: poll deployment status until runtime details exist
    Aleph-->>DeployAction: runtime networking, mapped ports, proxy URL, guest IPv6

    alt proxy URL reserved but not active yet
      DeployAction->>Aleph: wait for proxy activation attempts
      Aleph-->>DeployAction: active 2n6 route or still inactive
    end

    alt guest IPv6 is not globally routable for proxy-backed HTTPS
      DeployAction->>Aleph: clean up failed attempt
      DeployAction->>Scheduler: retry next compatible CRN
    else runtime is usable
      DeployAction->>Guest: wait for temporary /health and call /configure
      Guest-->>DeployAction: configuration accepted
      DeployAction->>Guest: poll /metadata until peerId + public multiaddrs are ready
      Guest-->>DeployAction: metadata ready
      DeployAction->>Guest: optional reachability verification
      Guest-->>DeployAction: reachable transports confirmed
      DeployAction->>Aleph: publish relay-bootstrap POST
      DeployAction->>Aleph: wait for bootstrap registration visibility
      DeployAction->>Aleph: forget/replace older records for the same registrationId
    end

    DeployAction-->>Reusable: VM outputs, verification JSON, runtime address sets

    Reusable->>Probe: relay-probe mode
    Probe->>Guest: probe required and best-effort transport families
    Probe-->>Reusable: protocol probe JSON + success/failure summary
  end

  opt publish=true and deploy_vm=true and retention enabled
    Reusable->>Retention: retain-successful-deployments mode
    Retention->>Aleph: forget stale deployment/site/rootfs records beyond keep count
    Aleph-->>Retention: retention result JSON
  end

  Reusable-->>Entry: export rootfs, site, VM, probe, and retention outputs
  Entry-->>Operator: workflow summary with manifest URLs, VM details, and probe results
```

## Implementation Anchors

These diagrams are derived from the current implementation in:

- `universal-connectivity/.github/workflows/build-aleph-go-peer-rootfs.yml`
- `universal-connectivity/.github/workflows/uc-go-peer-rootfs-reusable.yml`
- `universal-connectivity/go-peer/aleph/README.md`
- `relay-button/packages/node/src/deploy-executor.ts`
- `relay-button/packages/ui/src/shared/controller.ts`
- `relay-button/packages/core/src/bootstrap-registration.ts`
- `relay-button/packages/core/src/bootstrap-config.ts`

## Practical Reading Guide

If you are debugging a broken rollout, read the system in this order:

1. rootfs publish and manifest outputs
2. site publish and final manifest URL selection
3. VM deploy and CRN allocation notification
4. runtime suitability checks for proxy-backed HTTPS, including public guest IPv6
5. guest configure handoff and relay metadata confirmation
6. guest bootstrap registration visibility on Aleph
7. browser fallback publication, if any
8. browser discovery and relay dial from the published registry state

## Delete And Orphan Cleanup

The registration lifecycle does not end at publish time. The Sponsor Relay UI
also cleans up linked and orphaned registrations explicitly.

```mermaid
sequenceDiagram
  autonumber
  participant Browser as SponsorRelayFab / browser controller
  participant Wallet as Owner wallet
  participant Aleph as Aleph API
  participant Registry as Aleph bootstrap POST registry

  alt deleting a live instance
    Browser->>Wallet: sign FORGET for instance + linked registration hashes
    Browser->>Aleph: forget instance and linked bootstrap registrations
    Browser->>Aleph: refresh current instances and registrations
    Aleph-->>Browser: linked registration removed from panel state
  else forgetting an orphan registration
    Browser->>Wallet: sign FORGET for orphan registration hash
    Browser->>Registry: forget orphan bootstrap registration
    Browser->>Aleph: refresh current registrations
    Registry-->>Browser: orphan entry disappears from the panel
  end
```
