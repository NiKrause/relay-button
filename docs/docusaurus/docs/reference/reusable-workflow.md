# Reusable Workflow Reference

The shared reusable workflow entrypoint is:

- `.github/workflows/aleph-rootfs-build-publish-deploy.yml`

Its purpose is to give consumer repositories a ready-made GitHub Actions job
for:

1. checking out the caller repository
2. checking out `relay-button`
3. installing the shared workspace
4. building a RootFS image through the Aleph Rootfs Runner
5. optionally publishing that RootFS to IPFS and Aleph
6. exporting manifest and image outputs back to the caller workflow

## Current Status

This workflow is real and usable today for the RootFS build/publish part of the
pipeline.

It is not yet the full end-to-end Aleph deployment workflow.

Specifically:

- RootFS build is implemented
- RootFS publish is implemented
- manifest export is implemented
- artifact upload is implemented
- VM deploy inside this reusable workflow is still intentionally not wired

If `deploy_vm=true` is passed today, the workflow fails fast on purpose and
tells the caller to use the shared deploy action separately.

This limitation applies to the shared reusable workflow in `relay-button`
itself. Consumer repositories such as
`universal-connectivity` may still layer their own VM deployment workflow on
top of the shared RootFS stage.

## Inputs

Current supported inputs:

- `profile`
  Required profile identifier such as `uc-go-peer`.
- `publish`
  Whether to upload the built RootFS to IPFS and publish an Aleph `STORE`
  message.
- `deploy_vm`
  Reserved for future shared deployment wiring. Not implemented yet.
- `rootfs_version`
  Optional explicit version override for the generated RootFS manifest.
- `rootfs_contract_path`
  Path to the RootFS contract inside the caller repository.
- `rootfs_driver`
  RootFS build driver preference such as `auto`.
- `project_checkout_path`
  Checkout path used for the caller repository.
- `tooling_checkout_path`
  Checkout path used for `relay-button`.
- `tooling_repository`
  Repository that contains the shared tooling source.
- `tooling_ref`
  Ref of the shared tooling repository to checkout.

## Secrets

- `ALEPH_PRIVATE_KEY`
  Required only when `publish=true`.

## Outputs

The workflow currently exports:

- `rootfs_version`
- `rootfs_manifest_json`
- `rootfs_manifest_path`
- `rootfs_manifest_copy_target_path`
- `rootfs_manifest_versioned_path`
- `rootfs_image_path`
- `rootfs_execution_mode`
- `rootfs_cid`
- `rootfs_item_hash`
- `rootfs_source_size_bytes`
- `rootfs_manifest_cid`
- `rootfs_manifest_gateway_url`
- `rootfs_manifest_artifact_url`
- `rootfs_manifest_artifact_api_zip_url`

These outputs let a caller workflow continue with repo-specific steps such as:

- site publish or republish
- VM deployment through a separate action
- probe execution
- retention cleanup

## What The Workflow Actually Does

At a high level, the workflow:

1. checks out the caller repository
2. checks out `relay-button`
3. installs `pnpm` and Node
4. installs the shared workspace dependencies
5. validates input combinations
6. installs system packages needed for RootFS builds
7. runs `packages/node/src/rootfs-runner.ts`
8. validates published RootFS outputs when `publish=true`
9. exports the generated manifest JSON
10. publishes the generated manifest JSON to IPFS only when `publish=true`
11. uploads the resulting workspace artifacts
12. resolves the uploaded manifest artifact URLs and prints them in the job summary

## Manifest Artifact URLs

When the workflow uploads the generated RootFS manifest bundle, it also:

- exposes `rootfs_manifest_artifact_url` as a reusable workflow output
- exposes `rootfs_manifest_artifact_api_zip_url` as a reusable workflow output
- prints the GitHub artifact links in the workflow summary together with the manifest paths

When `publish=true`, the workflow also:

- requires the RootFS publisher to emit both `rootfs_cid` and `rootfs_item_hash`
- publishes the final manifest JSON itself to IPFS
- exposes `rootfs_manifest_cid` as a reusable workflow output
- exposes `rootfs_manifest_gateway_url` as a reusable workflow output
- prints the RootFS CID, Aleph item hash, manifest IPFS CID, and Aleph gateway URL in the workflow summary

When `publish=false`, no RootFS CID or Aleph STORE item hash is expected, and the manifest JSON is kept as a GitHub Actions artifact only. Those artifact URLs follow GitHub artifact retention and access rules.

## Validation Rules

The workflow currently enforces:

- `deploy_vm=true` is rejected because that stage is not wired yet
- `publish=true` requires `ALEPH_PRIVATE_KEY`

This is intentional. The workflow is designed to be honest about what it owns
today instead of pretending to be a full deploy pipeline already.

## Recommended Usage

Use this workflow when:

- you want shared RootFS build and publish behavior
- your consumer repo still wants to keep its own orchestration around deploy,
  site publishing, probing, or retention

Do not use it yet as the only deploy entrypoint if you expect:

- VM deployment
- site publishing
- domain linking
- retention cleanup

inside the same reusable workflow call.

## Relationship To The Package-Based Approach

This repo also supports a package-based integration model where consumer repos
install `@le-space/node` and call the Aleph runners directly from their own
workflows.

That package-based approach is still the more flexible option when:

- the consumer repo is public and the shared repo is private
- the consumer wants to keep its own workflow layout
- only part of the pipeline should be centralized

The reusable workflow is best understood as a shared RootFS stage, not yet a
complete shared deployment system.

## Site Publish Consumers

When a consumer repository uses `@le-space/node` directly for site publishing,
the upload step is handled in Node by `runSiteMode(...)`. The caller still
needs Aleph CLI access for pin and domain commands, but it no longer needs a
separate Python static-site upload helper chain.
