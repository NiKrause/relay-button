# Rootfs Contract Reference

The RootFS contract is the project-specific input that tells the Aleph tooling
how to build, describe, and publish a VM image profile.

In practice:

- consumer repos keep one contract file per profile
- `@le-space/rootfs` validates and parses the contract
- the Node runner exports the contract into shell env for the actual build path

The current `uc-go-peer` contract lives in:

- `universal-connectivity/go-peer/aleph/root-profiles/uc-go-peer.json`

## Contract Shape

The shared tooling currently validates this structure:

```json
{
  "schemaVersion": 1,
  "id": "uc-go-peer",
  "displayName": "Universal Connectivity Go Relay",
  "source": {
    "repository": "self",
    "subdirectory": "go-peer"
  },
  "rootfs": {
    "profile": "uc-go-peer",
    "installMode": "prebaked",
    "installDir": "/opt/go-peer",
    "binaryPath": "/usr/local/bin/universal-chat-go",
    "dataDir": "/var/lib/uc-go-peer",
    "envFile": "/etc/default/uc-go-peer"
  },
  "services": {
    "bootstrap": "uc-go-peer-bootstrap.service",
    "main": "uc-go-peer.service",
    "autotlsRefresh": "uc-go-peer-autotls-refresh.service"
  },
  "ports": [
    {
      "port": 22,
      "tcp": true,
      "udp": false,
      "purpose": "SSH"
    }
  ],
  "manifest": {
    "copyTarget": "js-peer/public/rootfs/uc-go-peer/latest.json",
    "notes": "Human-readable deployment notes."
  }
}
```

## Top-Level Fields

- `schemaVersion`
  Integer contract schema version.
- `id`
  Stable internal identifier for the profile.
- `displayName`
  Optional human-readable label.
- `source`
  Optional source repository hints used by the shared tooling.

## `source`

- `repository`
  Optional source repository marker. `self` means the caller repo.
- `subdirectory`
  Optional subdirectory that contains the source project.

For `uc-go-peer`, this is used to indicate that the build input comes from the
consumer repository’s `go-peer` directory.

## `rootfs`

The `rootfs` object describes how the guest image should be structured.

- `profile`
  Reference profile name. This selects the reusable reference assets packaged
  in `@le-space/rootfs`.
- `installMode`
  Consumer-specific install mode. `uc-go-peer` currently uses `prebaked`.
- `installDir`
  Guest install directory used by helper scripts.
- `binaryPath`
  Absolute path to the relay binary inside the image.
- `dataDir`
  Persistent runtime data directory inside the guest.
- `envFile`
  Guest environment file used by the relay and helper services.

## `services`

The `services` object names the important systemd units in the guest:

- `bootstrap`
  One-shot setup/bootstrap unit.
- `main`
  Main runtime service.
- `autotlsRefresh`
  AutoTLS refresh and announce adaptation service.

The shared tooling exports these into the shell environment so build and guest
scripts can stay profile-aware without hardcoding service names.

## `ports`

`ports` is a list of host-forward expectations that are copied into the rootfs
manifest published for consumers.

Each entry supports:

- `port`
  Required port number between `1` and `65535`.
- `tcp`
  Optional boolean.
- `udp`
  Optional boolean.
- `purpose`
  Optional human-readable description.

For `uc-go-peer`, this list documents the expected public ports for:

- SSH
- temporary setup on `80`
- proxy/Caddy HTTPS and WSS on `443`
- direct secure websocket listener on `9097`
- raw libp2p TCP/UDP transports on `9095`

## `manifest`

The `manifest` object controls how the generated RootFS manifest is copied back
into the consumer repo.

- `copyTarget`
  Relative path where the latest generated manifest should be copied.
- `notes`
  Optional human-readable explanation included in the manifest.

For `uc-go-peer`, the manifest is copied into the `js-peer` public assets so
browser-side consumers can discover the latest published RootFS.

## Validation Rules

The shared parser currently enforces:

- the contract must be an object
- `schemaVersion` must be an integer
- `id` must be a non-empty string
- `rootfs`, `services`, and `manifest` must be objects
- required string fields must be non-empty
- `ports` must be an array of valid port objects

The implementation lives in:

- `packages/rootfs/src/contract.ts`

## Shell Environment Export

After validation, the shared tooling exports the contract into shell variables
used by the RootFS build scripts. Important examples include:

- `ROOTFS_CONTRACT_ID`
- `ROOTFS_CONTRACT_PROFILE`
- `ROOTFS_CONTRACT_INSTALL_MODE`
- `ROOTFS_CONTRACT_INSTALL_DIR`
- `ROOTFS_CONTRACT_BINARY_PATH`
- `ROOTFS_CONTRACT_DATA_DIR`
- `ROOTFS_CONTRACT_ENV_FILE`
- `ROOTFS_CONTRACT_MAIN_SERVICE`
- `ROOTFS_CONTRACT_BOOTSTRAP_SERVICE`
- `ROOTFS_CONTRACT_AUTOTLS_SERVICE`
- `ROOTFS_CONTRACT_MANIFEST_COPY_TARGET`
- `ROOTFS_CONTRACT_PORT_FORWARDS_JSON`

This is how the contract becomes the bridge between:

- consumer repo profile data
- shared RootFS reference assets
- guest build/runtime behavior

## Recommended Consumer Pattern

For consumer repos:

1. keep one small contract file per deployable profile
2. keep project-specific values in the contract
3. keep reusable RootFS logic and guest baselines in `relay-button`

That keeps consumer repos thin while preserving explicit profile-level control.
