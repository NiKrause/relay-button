# Node CLI

`shared-aleph-tooling` now includes a small Node-only CLI wrapper around the
same shared runners used by the GitHub Action and reusable workflow layers.

It does not use any browser package code. It simply dispatches into:

- `packages/node/src/action-runner.ts`
- `packages/node/src/rootfs-runner.ts`

## Command

From the repository root:

```bash
pnpm aleph <command>
```

For machine-readable JSON output without the `pnpm run` banner, use the local
binary directly:

```bash
pnpm exec shared-aleph <command>
```

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
pnpm exec shared-aleph list-crns | jq
pnpm exec shared-aleph deploy
pnpm exec shared-aleph rootfs-publish
```

## Deploy A VM

Manifest-driven `uc-go-peer` example:

```bash
cd /path/to/shared-aleph-tooling

export ALEPH_VM_PRIVATE_KEY=0x...
export ALEPH_VM_NAME=uc-go-peer
export ALEPH_VM_SSH_PUBLIC_KEY="$(cat ~/.ssh/id_ed25519.pub)"
export ALEPH_VM_ROOTFS_MANIFEST_URL='https://connect.nicokrause.com/rootfs/uc-go-peer/latest.json'
export ALEPH_VM_PREFERRED_COUNTRY_CODE=DE
export ALEPH_VM_ENABLE_CADDY_PROXY=true

pnpm aleph deploy
```

When `ALEPH_VM_ROOTFS_MANIFEST_URL` is set, the shared CLI derives:

- `rootfsItemHash`
- `rootfsSizeMiB`
- `requiredPortForwards`
- the manifest version string

from the remote manifest automatically.

Direct item-hash example:

```bash
cd /path/to/shared-aleph-tooling

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

pnpm aleph deploy
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

## Build Or Publish A RootFS

```bash
cd /path/to/shared-aleph-tooling

export ALEPH_ROOTFS_PROJECT_DIR=/path/to/consumer-repo
export ALEPH_ROOTFS_CONTRACT_PATH=/path/to/consumer-repo/go-peer/aleph/root-profiles/uc-go-peer.json

pnpm aleph rootfs-plan
pnpm aleph rootfs-build
pnpm aleph rootfs-publish
```

OrbitDB relay example:

```bash
cd /path/to/shared-aleph-tooling

export ALEPH_ROOTFS_PROJECT_DIR=/path/to/relay-deployer-pwa
export ALEPH_ROOTFS_CONTRACT_PATH=/path/to/shared-aleph-tooling/packages/rootfs/reference/orbitdb-relay-pinner/contract.json
export ALEPH_ROOTFS_ORBITDB_RELAY_PINNER_DIR=/path/to/orbitdb-relay-pinner

pnpm aleph rootfs-build
pnpm aleph rootfs-publish
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

## Relationship To GitHub Automation

This CLI does not add a new deployment implementation. It exposes the existing
shared Node runners in a local command-line form.

- `pnpm aleph deploy`
  matches the same shared deploy path used by the `aleph-vm-deploy` action
- `pnpm aleph rootfs-publish`
  matches the same shared RootFS publish path used by the reusable workflow
