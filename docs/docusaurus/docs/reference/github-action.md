# GitHub Action Reference

The shared GitHub Action lives at:

- `.github/actions/aleph-vm-deploy/action.yml`

This action is the main shared entrypoint for Aleph VM deployment work today.

It wraps the Aleph Action Runner from `@le-space/node` and exposes a GitHub
Actions-friendly input/output contract for consumer workflows.

## Supported Modes

Current action modes:

- `deploy`
  Deploy an Aleph VM, optionally auto-configure the guest, optionally publish
  required port forwards, and emit runtime and verification outputs.
- `list-crns`
  Return ranked and geocoded CRN data for selection and diagnostics.

The Node runner also supports additional modes such as retention handling, but
those are not currently exposed through this specific composite action input
surface.

## Core Inputs

Deployment identity and signing:

- `mode`
- `profile`
- `aleph_private_key`
- `api_host`
- `api_hosts`
- `name`
- `channel`

RootFS and VM sizing:

- `rootfs_item_hash`
- `rootfs_version`
- `rootfs_size_mib`
- `vcpus`
- `memory_mib`
- `seconds`

CRN selection:

- `crn_hash`
- `preferred_country_code`
- `max_crn_attempts`
- `geo_crn_limit`
- `crn_list_url`

Guest access and lifecycle:

- `ssh_public_key`
- `enable_caddy_proxy`
- `auto_configure`
- `verify_reachability`
- `publish_port_forwards`
- `required_ports_json`

`required_ports_json` must be a JSON array of structured objects such as:

```json
[
  { "port": 22, "tcp": true, "udp": false, "purpose": "SSH" },
  {
    "port": 80,
    "tcp": true,
    "udp": false,
    "purpose": "Temporary setup endpoint"
  }
]
```

Do not pass raw port numbers such as `[22,80]`.

Aleph API host fallback:

- `api_host` configures the single Aleph API gateway used by default.
- `api_hosts` optionally configures a comma-, space-, or newline-separated list
  of Aleph API gateways to try in order during `deploy` mode.
- When `api_hosts` is set, it overrides `api_host` for the deployment attempt
  sequence. Each fallback attempt rebroadcasts the same deployment plan through
  the next API host.

Example:

```yaml
api_hosts: >-
  https://api.aleph.im,
  https://api2.aleph.im,
  https://api3.aleph.im
```

Polling and timeout controls:

- `wait_attempts`
- `wait_delay_ms`
- `runtime_attempts`
- `runtime_delay_ms`
- `setup_attempts`
- `setup_delay_ms`
- `verify_attempts`
- `verify_delay_ms`
- `metadata_attempts`
- `metadata_delay_ms`
- `metadata_timeout_ms`
- `configure_timeout_ms`
- `tcp_timeout_ms`
- `http_timeout_ms`

## Important Behavior

### `deploy`

In deploy mode, the action can:

1. sign and publish an Aleph `INSTANCE` message
2. poll Aleph until the deployment is processed
3. inspect CRN runtime networking
4. optionally publish a required-port `AGGREGATE`
5. optionally call the guest setup endpoint for `uc-go-peer`
6. collect relay peer and bootstrap metadata
7. optionally verify mapped ports and proxy reachability

### `list-crns`

In list mode, the action:

1. fetches the CRN list
2. ranks or filters it according to the shared selection logic
3. returns geocoded CRN data for diagnostics and manual selection

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

Guest configuration and relay outputs:

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

## Current Implementation Notes

The action is a composite GitHub Action.

Today it does three main things:

1. sets up Node
2. installs the small runtime dependency it still needs dynamically for
   deploy-mode signing
3. runs the shared action runner with inputs mapped into environment variables

That runtime dependency install is still intentional for now. The action is not
yet shipped as a fully bundled standalone distribution artifact.

## Example

```yaml
- name: Deploy uc-go-peer VM
  uses: ./.github/actions/aleph-vm-deploy
  with:
    mode: deploy
    profile: uc-go-peer
    aleph_private_key: ${{ secrets.ALEPH_PRIVATE_KEY }}
    name: uc-go-peer
    ssh_public_key: ${{ secrets.VM_SSH_PUBLIC_KEY }}
    rootfs_item_hash: ${{ steps.collect_rootfs.outputs.rootfs_item_hash }}
    preferred_country_code: DE
    max_crn_attempts: 5
    enable_caddy_proxy: true
    auto_configure: true
    verify_reachability: true
    publish_port_forwards: true
```

## When To Use This Action

Use this action when a consumer workflow wants to keep control of its own
workflow structure but reuse the shared Aleph deployment logic.

That is the current recommended pattern for repositories such as
`universal-connectivity`:

- keep project-specific workflow orchestration in the consumer repo
- call the shared deploy action for Aleph VM deployment work
- keep repo-specific site publish, probing, and reporting around it as needed
