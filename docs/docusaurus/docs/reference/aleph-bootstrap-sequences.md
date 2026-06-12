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
the VM should publish the final relay bootstrap record with the relay-side
publisher identity after the guest has real runtime networking.

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
  Aleph-->>Browser: processed + mapped ports + host IP / proxy URL
  Browser->>VM: configure guest with rootfs/runtime/bootstrap inputs
  Note over Browser,VM: configure writes owner authorization, publisher key material,<br/>deployment token, port-forwarding state, and optional proxy/Caddy settings.

  VM->>Relay: start relay with guest config and persisted identity
  Relay-->>VM: peerId + public multiaddrs + browser-safe multiaddrs
  VM->>Registry: publish relay-bootstrap POST with guest publisher identity
  Registry-->>Browser: bootstrap registration becomes visible
  Browser->>Registry: verify guest-published bootstrap registration

  alt guest registration is delayed
    Browser->>Registry: publish browser-side fallback bootstrap record
    Note over Browser,Registry: This is the temporary safety path used when the guest<br/>record does not appear in time.
  end

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
    Aleph-->>DeployAction: runtime networking, mapped ports, proxy URL
    DeployAction->>Guest: configure guest services and bootstrap inputs
    Guest->>Aleph: publish guest bootstrap registration after relay start
    Guest-->>DeployAction: peerId, probe multiaddrs, browser bootstrap multiaddrs
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
- `shared-aleph-tooling/packages/node/src/deploy-executor.ts`
- `shared-aleph-tooling/packages/ui/src/shared/controller.ts`
- `shared-aleph-tooling/packages/core/src/bootstrap-registration.ts`
- `shared-aleph-tooling/packages/core/src/bootstrap-config.ts`

## Practical Reading Guide

If you are debugging a broken rollout, read the system in this order:

1. rootfs publish and manifest outputs
2. site publish and final manifest URL selection
3. VM deploy and CRN allocation notification
4. guest configure and relay runtime verification
5. guest bootstrap registration visibility on Aleph
6. browser discovery and relay dial from the published registry state
