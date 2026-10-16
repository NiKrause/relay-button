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
- `crn_source`

`crn_list_url` points at `crns.json`, the polled CRN list. It stays the
preferred source because it carries live status, free capacity and QEMU
support. When it fails or comes back empty, the deploy falls back to the
`corechannel` aggregate and probes the candidates for reachability.

`crn_source: aggregate` skips `crns.json` entirely; the default is `auto`.

See [CRN discovery](./crn-discovery.md) for what each source knows, why the
aggregate is the fallback rather than the default, and what would change that.

Guest access and lifecycle:

- `ssh_public_key`
- `enable_caddy_proxy`
- `auto_configure`
- `verify_reachability`
- `publish_port_forwards`
- `required_ports_json`
- `confidential`, `luks_passphrase` (see [Confidential deploys](#confidential-deploys))

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
  of Aleph API gateways to try in order during deployment, retention cleanup,
  and relay bootstrap refresh steps.
- When `api_hosts` is set, it overrides `api_host` for the action attempt
  sequence. Each fallback attempt rebroadcasts the same action payload through
  the next API host.
- `api3.aleph.im` is unsupported and rejected. Use `api2.aleph.im` first and
  `api.aleph.im` as the fallback.

Example:

```yaml
api_hosts: >-
  https://api2.aleph.im,
  https://api.aleph.im
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

### Confidential deploys

With `confidential: true` the deploy starts an AMD SEV-SNP instance whose
rootfs the node operator cannot read. It needs two things from the caller:

- `rootfs_item_hash` must be a **LUKS-encrypted** rootfs. Build it with the
  composite action `.github/actions/aleph-confidential-rootfs`, which converts
  a profile image (no systemd as PID 1, no cloud-init: see
  `packages/rootfs/reference/confidential/README.md`), encrypts it and
  publishes it through IPFS and a STORE. The same `ssh_public_key` goes into
  both, because an encrypted image is not provisioned from outside.
- `luks_passphrase`, the passphrase it was encrypted with.

The deploy then differs in three places and is the same everywhere else:

1. only nodes that report SEV-SNP on aleph-vm 2.1.2 or newer are candidates
   (each node is asked; unknown is refused), never the scheduler;
2. the instance is created with Aleph's own CLI (pinned, checksummed), which
   pins the launch measurements in the message;
3. after the node starts it, the guest is attested (AMD certificate chain,
   measurement, policy, TCB floor) and only then is the passphrase sent, over
   the attested channel. A node whose attestation fails for good (firmware
   below the floor, no AMD certificate for its TCB) is forgotten at once and
   the next candidate is tried.

Port forwards, the setup endpoint, bootstrap registration and the
reachability check run as for any deploy. The smoke workflow **Aleph
Confidential Deploy Smoke** runs the whole path against a published
orbitdb-relay rootfs.

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
workflow structure but reuse the Relay Button deployment logic.

That is the current recommended pattern for repositories such as
`universal-connectivity`:

- keep project-specific workflow orchestration in the consumer repo
- call the shared deploy action for Aleph VM deployment work
- keep repo-specific site publish, probing, and reporting around it as needed
