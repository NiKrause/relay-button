# Reusable Workflow Reference

The shared reusable workflow path is reserved at:

- `.github/workflows/aleph-rootfs-build-publish-deploy.yml`

## Current Status

This workflow is still a scaffold.

Right now it accepts only a minimal contract:

- `profile`
- `publish`
- `deploy_vm`

and runs a placeholder job.

## Intended Role

The reusable workflow is planned to become the high-level automation entrypoint
that composes:

1. rootfs build
2. Aleph `STORE` publish
3. optional site publish or republish
4. VM deployment through the shared deploy action
5. successful-deployment retention cleanup

## Why It Is Not Finished Yet

The shared deploy action was migrated first because it had the clearest
cross-repo value and the tightest coupling to both UC and the future PWA flow.

The rootfs workflow still needs:

- shared rootfs package implementation
- reusable guest-script packaging
- stable rootfs manifest generation
- a finalized publish contract

## Recommendation For Now

Use the shared deploy action directly and treat the reusable workflow as
planned-but-not-finalized infrastructure.

That keeps the docs honest and avoids overstating the current implementation.
