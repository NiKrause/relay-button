# Node CLI

`relay-button` now includes a small Node-only CLI wrapper around the
same shared runners used by the GitHub Action and reusable workflow layers.

It does not use any browser package code. It simply dispatches into:

- `packages/node/src/action-runner.ts`
- `packages/node/src/rootfs-runner.ts`

## Command

From the repository root:

```bash
pnpm relay-button <command>
```

For machine-readable JSON output without the `pnpm run` banner, use the local
binary directly:

```bash
pnpm exec relay-button <command>
```

The legacy `shared-aleph` command remains available as a compatibility alias.

Supported commands:

- `deploy`
- `list-crns`
- `retain`
- `rootfs-plan`
- `rootfs-build`
- `rootfs-publish`
- `help`

Examples:

```bash
pnpm exec relay-button list-crns | jq
pnpm exec relay-button deploy
pnpm exec relay-button rootfs-publish
```

## Deploy A VM

Manifest-driven `uc-go-peer` example:

```bash
cd /path/to/relay-button

export ALEPH_VM_PRIVATE_KEY=0x...
export ALEPH_VM_NAME=uc-go-peer
export ALEPH_VM_SSH_PUBLIC_KEY="$(cat ~/.ssh/id_ed25519.pub)"
export ALEPH_VM_ROOTFS_MANIFEST_URL='https://connect.nicokrause.com/rootfs/uc-go-peer/latest.json'
export ALEPH_VM_PREFERRED_COUNTRY_CODE=DE
export ALEPH_VM_ENABLE_CADDY_PROXY=true

pnpm relay-button deploy
```

When `ALEPH_VM_ROOTFS_MANIFEST_URL` is set, the shared CLI derives:

- `rootfsItemHash`
- `rootfsSizeMiB`
- `requiredPortForwards`
- the manifest version string

from the remote manifest automatically.

Direct item-hash example:

```bash
cd /path/to/relay-button

export ALEPH_VM_PRIVATE_KEY=0x...
export ALEPH_VM_NAME=orbitdb-relay-pinner-01
export ALEPH_VM_SSH_PUBLIC_KEY="$(cat ~/.ssh/id_ed25519.pub)"
export ALEPH_VM_ROOTFS_ITEM_HASH=a83b2623e664f05671a7279003134f6fdb804527b17c97bbd571dc3c05d3b74f
export ALEPH_VM_PROFILE=orbitdb-relay-pinner
export ALEPH_VM_ROOTFS_VERSION=orbitdb-relay-pinner-v0.9.1
export ALEPH_VM_ROOTFS_SIZE_MIB=81920
export ALEPH_VM_VCPUS=4
export ALEPH_VM_MEMORY_MIB=8192
export ALEPH_VM_REQUIRED_PORTS_JSON='[
  {"port":22,"tcp":true,"udp":false,"purpose":"SSH"},
  {"port":80,"tcp":true,"udp":false,"purpose":"Temporary setup endpoint"},
  {"port":443,"tcp":true,"udp":false,"purpose":"HTTPS / WSS proxy"},
  {"port":9090,"tcp":true,"udp":false,"purpose":"Metrics"},
  {"port":9091,"tcp":true,"udp":false,"purpose":"Relay TCP"},
  {"port":9093,"tcp":false,"udp":true,"purpose":"WebRTC"},
  {"port":9094,"tcp":false,"udp":true,"purpose":"QUIC"}
]'

pnpm relay-button deploy
```

Important:

- `ALEPH_VM_REQUIRED_PORTS_JSON` must be a JSON array of structured port-forward objects.
- Do not pass raw port numbers like `[22,80,443,9095,9097]`.
- For `uc-go-peer`, use the manifest-derived shape shown above so the required Aleph port-forward aggregate is published correctly.

Minimum required environment for `deploy`:

- `ALEPH_VM_PRIVATE_KEY`
- `ALEPH_VM_NAME`
- `ALEPH_VM_SSH_PUBLIC_KEY`
- either `ALEPH_VM_ROOTFS_ITEM_HASH` or `ALEPH_VM_ROOTFS_MANIFEST_URL`

Common optional environment:

- `ALEPH_VM_PROFILE`
- `ALEPH_VM_ROOTFS_MANIFEST_URL`
- `ALEPH_VM_ROOTFS_VERSION`
- `ALEPH_VM_ROOTFS_SIZE_MIB`
- `ALEPH_VM_VCPUS`
- `ALEPH_VM_MEMORY_MIB`
- `ALEPH_VM_CRN_HASH`
- `ALEPH_VM_PREFERRED_COUNTRY_CODE`
- `ALEPH_VM_REQUIRED_PORTS_JSON`
- `ALEPH_VM_BOOTSTRAP_PUBLISHER_PRIVATE_KEY`
- `ALEPH_VM_BOOTSTRAP_OWNER_PRIVATE_KEY`

Dual-key bootstrap note:

- `ALEPH_VM_PRIVATE_KEY` still owns the Aleph VM deployment itself
- if `ALEPH_VM_BOOTSTRAP_PUBLISHER_PRIVATE_KEY` is provided, bootstrap
  registration can be published by that separate publisher identity instead of
  the deployer wallet
- if `ALEPH_VM_BOOTSTRAP_OWNER_PRIVATE_KEY` is also provided, deploy-time
  publication mints the owner authorization needed for dual-key verification
- the current deploy flow writes that signed authorization record back into the
  guest with a second `no_start` configure call, so the VM can later refresh
  with publisher key `B` without keeping owner key `A` as the preferred
  long-lived guest secret

## Build Or Publish A RootFS

```bash
cd /path/to/relay-button

export ALEPH_ROOTFS_PROJECT_DIR=/path/to/consumer-repo
export ALEPH_ROOTFS_CONTRACT_PATH=/path/to/consumer-repo/go-peer/aleph/root-profiles/uc-go-peer.json

pnpm relay-button rootfs-plan
pnpm relay-button rootfs-build
pnpm relay-button rootfs-publish
```

OrbitDB relay example:

```bash
cd /path/to/relay-button

export ALEPH_ROOTFS_PROJECT_DIR=/path/to/relay-deployer-pwa
export ALEPH_ROOTFS_CONTRACT_PATH=/path/to/relay-button/packages/rootfs/reference/orbitdb-relay-pinner/contract.json
export ALEPH_ROOTFS_ORBITDB_RELAY_PINNER_DIR=/path/to/orbitdb-relay-pinner

pnpm relay-button rootfs-build
pnpm relay-button rootfs-publish
```

Minimum required environment for `rootfs-publish`:

- `ALEPH_ROOTFS_PROJECT_DIR`
- `ALEPH_ROOTFS_CONTRACT_PATH`

Common optional environment:

- `ALEPH_ROOTFS_VERSION`
- `ALEPH_ROOTFS_DRIVER`
- `ALEPH_ROOTFS_SKIP_UPLOAD`
- `ALEPH_ROOTFS_SKIP_BUILD`
- `ALEPH_ROOTFS_IPFS_ADD_URL`
- `ALEPH_ROOTFS_ALEPH_API_HOST`
- `ALEPH_ROOTFS_ORBITDB_RELAY_PINNER_DIR`
  Required when the contract/profile is `orbitdb-relay-pinner`.

Retry tip:

If the qcow2/rootfs image was already built successfully but Aleph rejected the
later `STORE` publish step, for example due to insufficient Aleph balance, you
can retry the upload/publication step without rebuilding the image:

```bash
export ALEPH_ROOTFS_DRIVER=docker
export ALEPH_ROOTFS_SKIP_BUILD=true
pnpm relay-button rootfs-publish
```

The shared rootfs runner now auto-detects `docker` / `virt-customize` when
those flags are omitted. `ALEPH_ROOTFS_HAS_DOCKER`,
`ALEPH_ROOTFS_DOCKER_DAEMON_RUNNING`, and
`ALEPH_ROOTFS_HAS_VIRT_CUSTOMIZE` remain available as manual overrides when
you need to force or debug toolchain selection.

## Relationship To GitHub Automation

This CLI does not add a new deployment implementation. It exposes the existing
shared Node runners in a local command-line form.

- `pnpm relay-button deploy`
  matches the same shared deploy path used by the `aleph-vm-deploy` action
- `pnpm relay-button rootfs-publish`
  matches the same shared RootFS publish path used by the reusable workflow
