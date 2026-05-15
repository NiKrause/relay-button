# Deployment Lifecycle

This page describes the current shared deployment flow implemented by
`@shared-aleph/core` and `@shared-aleph/node`.

## High-Level Flow

1. Validate the rootfs reference and deployment inputs.
2. Resolve or rank CRN candidates.
3. Build and sign the Aleph `INSTANCE` message.
4. Broadcast the deployment request.
5. Optionally publish required port forwards through an Aleph `AGGREGATE`.
6. Wait for Aleph to process the deployment message.
7. Poll runtime endpoints until networking becomes available.
8. For `uc-go-peer`, notify the CRN allocation, wait for the setup endpoint,
   run `/configure`, then fetch `/metadata`.
9. Verify required TCP and HTTPS reachability.
10. If deployment fails on a CRN, forget failed messages and retry the next
    candidate when appropriate.

## Shared Core Modules

- `manifests.ts`
  Manifest validation plus rootfs `STORE` existence and gateway probing.
- `crns.ts`
  CRN list fetching, compatibility filtering, geo enrichment, ranking, and
  preferred-country selection.
- `instance-deployment.ts`
  Aleph `INSTANCE` payload creation and message broadcasting.
- `aggregate-publication.ts`
  Port-forward aggregate publication.
- `deployment-inspection.ts`
  Aleph message polling and rejection diagnostics.
- `runtime.ts`
  Scheduler, execution-map, and runtime availability inspection.
- `guest.ts`
  `uc-go-peer` setup, metadata fetch, and reachability verification.
- `forget.ts`
  Cleanup of failed deployments.
- `retention.ts`
  Successful-deployment ledger maintenance and forgetting old resources.

## Retry Model

The current shared deploy executor supports:

- explicit `crn_hash` pinning
- preferred-country ranking
- multi-CRN retry when a deployment is rejected
- cleanup of failed deployment attempts before moving to the next CRN

This keeps the higher-level consumer workflows simpler because the retry
behavior now lives in shared code instead of repo-local scripts.

## `uc-go-peer` Guest Lifecycle

The current shared implementation includes the `uc-go-peer` operational flow:

1. deploy VM
2. wait for runtime networking
3. notify CRN allocation endpoint
4. wait for temporary setup endpoint
5. submit `/configure`
6. poll `/metadata`
7. verify relay ports and optional HTTPS proxy

That makes the shared repo more than a raw Aleph SDK. It already contains the
first app-profile lifecycle that UC needs today.

## Retention Flow

The shared retention logic stores a ledger under the Aleph aggregate key
`uc-go-peer-successful-deployments`.

Each successful record may include:

- `instance_item_hash`
- `rootfs_item_hash`
- `site_item_hash`
- `rootfs_cid`
- `site_url`
- `relay_peer_id`
- `rootfs_version`
- `vm_name`
- `deployed_at`

When the keep limit is exceeded, older Aleph hashes are collected and forgotten
through a shared `FORGET` message.
