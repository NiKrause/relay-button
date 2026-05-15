# GitHub Action Reference

The shared GitHub Action lives at:

- `.github/actions/aleph-vm-deploy/action.yml`

It is the main automation entrypoint for shared VM deployment logic today.

## Current Modes

- `deploy`
  Deploy an Aleph VM, optionally configure `uc-go-peer`, and emit runtime and
  verification outputs.
- `list-crns`
  Return geocoded CRN data for selection and diagnostics.

The Node runner also supports `retain-successful-deployments`, but that mode is
currently used directly by the UC reusable workflow rather than being exposed as
an action input contract.

## Important Inputs

Core deployment inputs:

- `mode`
- `profile`
- `aleph_private_key`
- `api_host`
- `name`
- `ssh_public_key`
- `rootfs_item_hash`
- `rootfs_version`
- `rootfs_size_mib`
- `vcpus`
- `memory_mib`
- `channel`

CRN selection inputs:

- `crn_hash`
- `preferred_country_code`
- `geo_crn_limit`
- `max_crn_attempts`
- `crn_list_url`

Polling and runtime inputs:

- `wait_attempts`
- `wait_delay_ms`
- `runtime_attempts`
- `runtime_delay_ms`
- `setup_attempts`
- `setup_delay_ms`
- `verify_attempts`
- `verify_delay_ms`
- `tcp_timeout_ms`
- `http_timeout_ms`

`uc-go-peer` lifecycle inputs:

- `enable_caddy_proxy`
- `auto_configure`
- `verify_reachability`
- `required_ports_json`

## Important Outputs

Deployment identity:

- `deployer_address`
- `instance_item_hash`
- `instance_status`

Port-forward publication:

- `port_forward_aggregate_item_hash`
- `port_forward_status`
- `port_forwarding_json`

Selected CRN and runtime details:

- `crn_hash`
- `crn_name`
- `crn_url`
- `host_ipv4`
- `ipv6`
- `web_proxy_url`
- `ssh_command`
- `mapped_ports_json`
- `runtime_json`

Guest configuration outputs:

- `setup_endpoint_ok`
- `configuration_json`
- `relay_peer_id`
- `probe_multiaddrs_json`
- `browser_bootstrap_multiaddrs_json`

Verification outputs:

- `verification_ok`
- `verification_json`

CRN listing outputs:

- `geocoded_crns_json`
- `geocoded_crn_count`

## Runtime Dependency Note

The shared action currently installs `ethers` at runtime before deploy-mode
execution. That is temporary but intentional: the shared Node signer path uses
`ethers`, while the repo is still in the early scaffold stage and does not yet
ship a fully installed packaged action bundle.

## Example

```yaml
- name: Deploy uc-go-peer VM
  uses: ./shared-aleph-tooling/.github/actions/aleph-vm-deploy
  with:
    profile: uc-go-peer
    mode: deploy
    aleph_private_key: ${{ secrets.ALEPH_PRIVATE_KEY }}
    name: uc-go-peer
    ssh_public_key: ${{ secrets.VM_SSH_PUBLIC_KEY }}
    rootfs_item_hash: ${{ steps.collect_rootfs.outputs.rootfs_item_hash }}
    preferred_country_code: DE
    max_crn_attempts: 5
    enable_caddy_proxy: true
```
