#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_DIR="$(cd "${APP_DIR}/.." && pwd)"
OUT_DIR="${OUT_DIR:-${APP_DIR}/dist-rootfs}"
ROOTFS_CONTRACT_FILE="${ROOTFS_CONTRACT_FILE:-}"
ROOTFS_PROFILE="${ROOTFS_PROFILE:-}"
ROOTFS_INSTALL_MODE="${ROOTFS_INSTALL_MODE:-}"
ROOTFS_BUILD_DRIVER="${ROOTFS_BUILD_DRIVER:-auto}"
ROOTFS_SIZE_MIB="${ROOTFS_SIZE_MIB:-20480}"
CHANNEL="${CHANNEL:-ALEPH-CLOUDSOLUTIONS}"
SKIP_UPLOAD="${SKIP_UPLOAD:-0}"
SKIP_BUILD="${SKIP_BUILD:-0}"
IPFS_ADD_URL="${IPFS_ADD_URL:-https://ipfs.aleph.cloud/api/v0/add}"
ORBITDB_RELAY_PINNER_DIR="${ORBITDB_RELAY_PINNER_DIR:-}"
UNIVERSAL_CONNECTIVITY_DIR="${UNIVERSAL_CONNECTIVITY_DIR:-}"

require() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

die() {
  echo "$*" >&2
  exit 1
}

load_rootfs_contract() {
  [ -n "${ROOTFS_CONTRACT_FILE}" ] || return 0
  require node
  [ -f "${ROOTFS_CONTRACT_FILE}" ] || die "Rootfs contract does not exist: ${ROOTFS_CONTRACT_FILE}"

  # The contract is relay-owned metadata. We load it once here so users can
  # select a standardized profile without repeating profile/install-mode flags.
  eval "$(node "${SCRIPT_DIR}/read-rootfs-contract.mjs" "${ROOTFS_CONTRACT_FILE}")"

  if [ -n "${ROOTFS_PROFILE}" ] && [ "${ROOTFS_PROFILE}" != "${ROOTFS_CONTRACT_PROFILE}" ]; then
    die "ROOTFS_PROFILE=${ROOTFS_PROFILE} conflicts with contract profile ${ROOTFS_CONTRACT_PROFILE}"
  fi
  if [ -n "${ROOTFS_INSTALL_MODE}" ] && [ "${ROOTFS_INSTALL_MODE}" != "${ROOTFS_CONTRACT_INSTALL_MODE}" ]; then
    die "ROOTFS_INSTALL_MODE=${ROOTFS_INSTALL_MODE} conflicts with contract install mode ${ROOTFS_CONTRACT_INSTALL_MODE}"
  fi

  ROOTFS_PROFILE="${ROOTFS_CONTRACT_PROFILE}"
  ROOTFS_INSTALL_MODE="${ROOTFS_INSTALL_MODE:-${ROOTFS_CONTRACT_INSTALL_MODE}}"
  echo "Loaded rootfs contract: ${ROOTFS_CONTRACT_PATH}"
}

load_rootfs_contract
ROOTFS_PROFILE="${ROOTFS_PROFILE:-py-libp2p}"

case "${ROOTFS_PROFILE}" in
  py-libp2p)
    IMAGE_BASENAME="aleph-py-libp2p-relay.qcow2"
    DEFAULT_ROOTFS_VERSION="py-libp2p-relay-v0.1.0"
    if [ -z "${ROOTFS_INSTALL_MODE}" ]; then
      ROOTFS_INSTALL_MODE="thin"
    fi
    ;;
  orbitdb-relay-pinner)
    IMAGE_BASENAME="aleph-orbitdb-relay-pinner.qcow2"
    DEFAULT_ROOTFS_VERSION="orbitdb-relay-pinner-v0.1.0"
    if [ -z "${ROOTFS_INSTALL_MODE}" ]; then
      ROOTFS_INSTALL_MODE="prebaked"
    fi
    ;;
  uc-go-peer)
    IMAGE_BASENAME="aleph-uc-go-peer.qcow2"
    DEFAULT_ROOTFS_VERSION="uc-go-peer-v0.1.0"
    if [ -z "${ROOTFS_INSTALL_MODE}" ]; then
      ROOTFS_INSTALL_MODE="prebaked"
    fi
    ;;
  uc-rust-peer)
    IMAGE_BASENAME="aleph-uc-rust-peer.qcow2"
    DEFAULT_ROOTFS_VERSION="uc-rust-peer-v0.1.0"
    if [ -z "${ROOTFS_INSTALL_MODE}" ]; then
      ROOTFS_INSTALL_MODE="prebaked"
    fi
    ;;
  *)
    echo "Unsupported ROOTFS_PROFILE: ${ROOTFS_PROFILE}" >&2
    echo "Expected one of: py-libp2p, orbitdb-relay-pinner, uc-go-peer, uc-rust-peer" >&2
    exit 1
    ;;
esac

case "${ROOTFS_INSTALL_MODE}" in
  thin|prebaked)
    ;;
  *)
    echo "Unsupported ROOTFS_INSTALL_MODE: ${ROOTFS_INSTALL_MODE}" >&2
    echo "Expected one of: thin, prebaked" >&2
    exit 1
    ;;
esac

case "${ROOTFS_BUILD_DRIVER}" in
  auto|host|docker)
    ;;
  *)
    echo "Unsupported ROOTFS_BUILD_DRIVER: ${ROOTFS_BUILD_DRIVER}" >&2
    echo "Expected one of: auto, host, docker" >&2
    exit 1
    ;;
esac

IMAGE="${OUT_DIR}/${IMAGE_BASENAME}"

resolve_rootfs_version() {
  if [ -n "${ROOTFS_VERSION:-}" ]; then
    printf '%s\n' "${ROOTFS_VERSION}"
    return
  fi

  if [ "${ROOTFS_PROFILE}" = "orbitdb-relay-pinner" ] && [ -n "${ORBITDB_RELAY_PINNER_DIR}" ]; then
    local orbitdb_package_json="${ORBITDB_RELAY_PINNER_DIR}/package.json"
    if [ -f "${orbitdb_package_json}" ] && command -v node >/dev/null 2>&1; then
      local orbitdb_version
      orbitdb_version="$(
        node -e "const fs=require('node:fs');const payload=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));const version=typeof payload.version==='string'?payload.version.trim():'';if(!version)process.exit(1);console.log('orbitdb-relay-pinner-v'+version.replace(/^v/,''));" "${orbitdb_package_json}"
      )" || orbitdb_version=""

      if [ -n "${orbitdb_version}" ]; then
        printf '%s\n' "${orbitdb_version}"
        return
      fi
    fi
  fi

  if [ "${ROOTFS_PROFILE}" = "uc-rust-peer" ] && [ -n "${UNIVERSAL_CONNECTIVITY_DIR}" ]; then
    local rust_peer_cargo_toml="${UNIVERSAL_CONNECTIVITY_DIR}/rust-peer/Cargo.toml"
    if [ -f "${rust_peer_cargo_toml}" ]; then
      local rust_peer_version
      rust_peer_version="$(
        sed -nE 's/^version = "([^"]+)"/uc-rust-peer-v\1/p' "${rust_peer_cargo_toml}" | head -n 1
      )"
      if [ -n "${rust_peer_version}" ]; then
        printf '%s\n' "${rust_peer_version}"
        return
      fi
    fi
  fi

  if [ "${ROOTFS_PROFILE}" = "uc-go-peer" ] && [ -n "${UNIVERSAL_CONNECTIVITY_DIR}" ]; then
    if [ -f "${UNIVERSAL_CONNECTIVITY_DIR}/go-peer/go.mod" ]; then
      printf '%s\n' "${DEFAULT_ROOTFS_VERSION}"
      return
    fi
  fi

  printf '%s\n' "${DEFAULT_ROOTFS_VERSION}"
}

ROOTFS_VERSION="$(resolve_rootfs_version)"

build_with_host_tools() {
  echo "Using host virt-customize/qemu-img toolchain."
  "${SCRIPT_DIR}/build-rootfs-image.sh"
}

build_with_docker() {
  require docker

  if ! docker info >/dev/null 2>&1; then
    echo "Docker is installed, but the Docker daemon is not running." >&2
    echo "Start Docker Desktop, wait until it is ready, then rerun rootfs/build-rootfs.sh." >&2
    exit 1
  fi

  echo "virt-customize is not available on this host."
  echo "Using Dockerized Debian/libguestfs builder instead."
  echo "This can be slow on macOS because qemu may run without hardware acceleration."

  docker build --platform linux/amd64 \
    -t aleph-relay-rootfs-builder:local \
    -f "${SCRIPT_DIR}/Dockerfile.rootfs" \
    "${SCRIPT_DIR}"

  local orbitdb_mount=()
  local orbitdb_env=()
  local uc_mount=()
  local uc_env=()
  if [ "${ROOTFS_PROFILE}" = "orbitdb-relay-pinner" ]; then
    if [ -z "${ORBITDB_RELAY_PINNER_DIR}" ]; then
      echo "ROOTFS_PROFILE=orbitdb-relay-pinner requires ORBITDB_RELAY_PINNER_DIR=/path/to/orbitdb-relay-pinner" >&2
      exit 1
    fi
    if [ ! -d "${ORBITDB_RELAY_PINNER_DIR}" ]; then
      echo "Missing orbitdb-relay-pinner directory: ${ORBITDB_RELAY_PINNER_DIR}" >&2
      exit 1
    fi
    orbitdb_mount=(-v "${ORBITDB_RELAY_PINNER_DIR}:/workspace-orbitdb-relay-pinner:ro")
    orbitdb_env=(-e ORBITDB_RELAY_PINNER_DIR=/workspace-orbitdb-relay-pinner)
  fi
  if [ "${ROOTFS_PROFILE}" = "uc-rust-peer" ]; then
    if [ -z "${UNIVERSAL_CONNECTIVITY_DIR}" ]; then
      echo "ROOTFS_PROFILE=uc-rust-peer requires UNIVERSAL_CONNECTIVITY_DIR=/path/to/universal-connectivity" >&2
      exit 1
    fi
    if [ ! -d "${UNIVERSAL_CONNECTIVITY_DIR}/rust-peer" ]; then
      echo "Missing rust-peer directory: ${UNIVERSAL_CONNECTIVITY_DIR}/rust-peer" >&2
      exit 1
    fi
    uc_mount=(-v "${UNIVERSAL_CONNECTIVITY_DIR}:/workspace-universal-connectivity:ro")
    uc_env=(-e UNIVERSAL_CONNECTIVITY_DIR=/workspace-universal-connectivity)
  fi
  if [ "${ROOTFS_PROFILE}" = "uc-go-peer" ]; then
    if [ -z "${UNIVERSAL_CONNECTIVITY_DIR}" ]; then
      echo "ROOTFS_PROFILE=uc-go-peer requires UNIVERSAL_CONNECTIVITY_DIR=/path/to/universal-connectivity" >&2
      exit 1
    fi
    if [ ! -d "${UNIVERSAL_CONNECTIVITY_DIR}/go-peer" ]; then
      echo "Missing go-peer directory: ${UNIVERSAL_CONNECTIVITY_DIR}/go-peer" >&2
      exit 1
    fi
    uc_mount=(-v "${UNIVERSAL_CONNECTIVITY_DIR}:/workspace-universal-connectivity:ro")
    uc_env=(-e UNIVERSAL_CONNECTIVITY_DIR=/workspace-universal-connectivity)
  fi

  docker run --rm --privileged --platform linux/amd64 \
    -e LIBGUESTFS_BACKEND=direct \
    -e ROOTFS_PROFILE="${ROOTFS_PROFILE}" \
    -e ROOTFS_INSTALL_MODE="${ROOTFS_INSTALL_MODE}" \
    -e PY_LIBP2P_DIR=/workspace/py-libp2p \
    "${orbitdb_env[@]}" \
    "${uc_env[@]}" \
    -e OUT_DIR=/workspace/relay-deployer-pwa/dist-rootfs \
    -e BASE_URL="${BASE_URL:-}" \
    -e IMAGE_SIZE="${IMAGE_SIZE:-20G}" \
    -v "${REPO_DIR}:/workspace" \
    "${orbitdb_mount[@]}" \
    "${uc_mount[@]}" \
    -w /workspace/relay-deployer-pwa \
    aleph-relay-rootfs-builder:local \
    bash rootfs/build-rootfs-image.sh
}

required_port_forwards_json() {
  if [ -n "${ROOTFS_CONTRACT_PORT_FORWARDS_JSON:-}" ]; then
    printf '  "requiredPortForwards": %s,\n' "${ROOTFS_CONTRACT_PORT_FORWARDS_JSON}"
    return
  fi

  case "${ROOTFS_PROFILE}" in
    orbitdb-relay-pinner)
      cat <<'EOF'
  "requiredPortForwards": [
    { "port": 22, "tcp": true, "udp": false, "purpose": "SSH" },
    { "port": 80, "tcp": true, "udp": false, "purpose": "Temporary setup endpoint" },
    { "port": 9090, "tcp": true, "udp": false, "purpose": "Metrics and health API" },
    { "port": 9091, "tcp": true, "udp": false, "purpose": "libp2p TCP" },
    { "port": 443, "tcp": true, "udp": false, "purpose": "Caddy HTTPS and WSS proxy" },
    { "port": 9093, "tcp": false, "udp": true, "purpose": "WebRTC direct" },
    { "port": 9094, "tcp": false, "udp": true, "purpose": "QUIC" }
  ],
EOF
      ;;
    uc-rust-peer)
      cat <<'EOF'
  "requiredPortForwards": [
    { "port": 22, "tcp": true, "udp": false, "purpose": "SSH" },
    { "port": 80, "tcp": true, "udp": false, "purpose": "Temporary setup endpoint" },
    { "port": 9092, "tcp": true, "udp": false, "purpose": "libp2p TCP" },
    { "port": 9093, "tcp": true, "udp": false, "purpose": "WebSocket bridge" },
    { "port": 443, "tcp": true, "udp": false, "purpose": "Caddy HTTPS and WSS proxy" },
    { "port": 9090, "tcp": false, "udp": true, "purpose": "WebRTC direct" },
    { "port": 9091, "tcp": false, "udp": true, "purpose": "QUIC" }
  ],
EOF
      ;;
    uc-go-peer)
      cat <<'EOF'
  "requiredPortForwards": [
    { "port": 22, "tcp": true, "udp": false, "purpose": "SSH" },
    { "port": 80, "tcp": true, "udp": false, "purpose": "Temporary setup endpoint" },
    { "port": 443, "tcp": true, "udp": false, "purpose": "Caddy HTTPS and WSS proxy" },
    { "port": 9095, "tcp": true, "udp": true, "purpose": "libp2p raw TCP and UDP transports" }
  ],
EOF
      ;;
  esac
}

sync_manifest_copy_target() {
  local manifest_path="${OUT_DIR}/rootfs-manifest.json"
  local copy_target="${ROOTFS_CONTRACT_MANIFEST_COPY_TARGET:-}"
  local resolved_target=""
  local target_dir=""
  local target_ext=".json"
  local versioned_target=""

  [ -n "${copy_target}" ] || return 0
  [ -f "${manifest_path}" ] || die "Manifest does not exist: ${manifest_path}"

  if [[ "${copy_target}" = /* ]]; then
    resolved_target="${copy_target}"
  else
    resolved_target="${REPO_DIR}/${copy_target}"
  fi

  target_dir="$(dirname "${resolved_target}")"
  mkdir -p "${target_dir}"
  cp "${manifest_path}" "${resolved_target}"

  case "${resolved_target}" in
    *.json)
      target_ext=".json"
      ;;
  esac

  versioned_target="${target_dir}/${ROOTFS_VERSION}${target_ext}"
  cp "${manifest_path}" "${versioned_target}"

  echo "Copied rootfs manifest to ${resolved_target}"
  echo "Copied versioned rootfs manifest to ${versioned_target}"
}

write_manifest() {
  local rootfs_item_hash="$1"
  local rootfs_source_size_bytes=""
  local requires_bootstrap_network="false"
  local bootstrap_summary="Dependencies are preinstalled in the image."
  local notes="${ROOTFS_CONTRACT_MANIFEST_NOTES:-}"

  if [ "${ROOTFS_INSTALL_MODE}" = "thin" ]; then
    requires_bootstrap_network="true"
    bootstrap_summary="First boot installs runtime packages and application dependencies. Outbound network access is required before the relay service becomes healthy."
  fi

  if [ -z "${notes}" ] && [ "${ROOTFS_PROFILE}" = "uc-rust-peer" ]; then
    notes="The rust-peer image publishes a WSS bridge on 443 for browser clients, but the upstream peer does not yet self-advertise host-remapped websocket multiaddrs. Use the mapped proxy hostname or explicit multiaddrs from deployment metadata."
  fi
  if [ -z "${notes}" ] && [ "${ROOTFS_PROFILE}" = "uc-go-peer" ]; then
    notes="The go-peer image keeps the relay on internal port 9095, then advertises raw TCP on external port 80, secure WebSocket on 443 via Caddy, and a single externally mapped UDP port for QUIC, WebTransport, and WebRTC-direct."
  fi

  if [ -f "${OUT_DIR}/ipfs-add-response.jsonl" ]; then
    rootfs_source_size_bytes="$(python3 - "${OUT_DIR}/ipfs-add-response.jsonl" <<'PY'
import json
import sys
from pathlib import Path

lines = [line for line in Path(sys.argv[1]).read_text().splitlines() if line.strip()]
if not lines:
    raise SystemExit(0)

payload = json.loads(lines[-1])
size = payload.get("Size")
if isinstance(size, str) and size.isdigit():
    print(size)
elif isinstance(size, int) and size > 0:
    print(size)
PY
)"
  fi

  cat > "${OUT_DIR}/rootfs-manifest.json" <<EOF
{
  "profile": "${ROOTFS_PROFILE}",
  "version": "${ROOTFS_VERSION}",
  "rootfsInstallStrategy": "${ROOTFS_INSTALL_MODE}",
  "requiresBootstrapNetwork": ${requires_bootstrap_network},
  "bootstrapSummary": "${bootstrap_summary}",
$(if [[ "${rootfs_source_size_bytes}" =~ ^[0-9]+$ ]]; then printf '  "rootfsSourceSizeBytes": %s,\n' "${rootfs_source_size_bytes}"; fi)$(required_port_forwards_json)  "rootfsItemHash": "${rootfs_item_hash}",
  "rootfsSizeMiB": ${ROOTFS_SIZE_MIB},
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"$(if [ -n "${notes}" ]; then printf ',\n  "notes": "%s"' "${notes}"; fi)
}
EOF

  echo "Rootfs manifest written to ${OUT_DIR}/rootfs-manifest.json"
  sync_manifest_copy_target
}

upload_image() {
  require node
  require curl
  [ -f "${IMAGE}" ] || die "Rootfs image does not exist: ${IMAGE}"

  echo "Uploading ${IMAGE} to IPFS via ${IPFS_ADD_URL}..." >&2
  : > "${OUT_DIR}/ipfs-add-response.jsonl"
  if ! curl --fail --silent --show-error \
    -X POST \
    -F "file=@${IMAGE}" \
    "${IPFS_ADD_URL}" \
    > "${OUT_DIR}/ipfs-add-response.jsonl"; then
    die "IPFS upload failed for ${IMAGE}"
  fi

  local cid
  if ! cid="$(
    node -e "const fs=require('node:fs');const lines=fs.readFileSync(process.argv[1],'utf8').split(/\\r?\\n/).map((line)=>line.trim()).filter(Boolean);if(!lines.length){console.error('No response received from the IPFS add endpoint');process.exit(1)}const payload=JSON.parse(lines.at(-1));if(typeof payload.Hash!=='string'||!payload.Hash.trim()){console.error('IPFS add response did not include a Hash');process.exit(1)}console.log(payload.Hash.trim());" "${OUT_DIR}/ipfs-add-response.jsonl"
  )"; then
    die "Failed to extract CID from ${OUT_DIR}/ipfs-add-response.jsonl"
  fi
  [ -n "${cid}" ] || die "IPFS upload returned an empty CID"

  echo "Pinning CID ${cid} on Aleph Cloud via direct API call..." >&2
  : > "${OUT_DIR}/store-message.json"
  if ! node "${SCRIPT_DIR}/publish-store-message.mjs" "${cid}" > "${OUT_DIR}/store-message.json"; then
    die "Aleph pin failed for CID ${cid}"
  fi

  if ! node -e "const fs=require('node:fs');const content=fs.readFileSync(process.argv[1],'utf8').trim();if(!content){console.error('Aleph pin returned an empty response');process.exit(1)}const payload=JSON.parse(content);if(typeof payload.item_hash!=='string'||!payload.item_hash.trim()){console.error('Failed to extract item_hash');process.exit(1)}console.log(payload.item_hash.trim());" "${OUT_DIR}/store-message.json"; then
    die "Failed to extract item_hash from ${OUT_DIR}/store-message.json"
  fi
}

mkdir -p "${OUT_DIR}"

echo "Building rootfs profile: ${ROOTFS_PROFILE}"
echo "Using install mode: ${ROOTFS_INSTALL_MODE}"

if [ "${SKIP_BUILD}" != "1" ]; then
  case "${ROOTFS_BUILD_DRIVER}" in
    host)
      if command -v virt-customize >/dev/null 2>&1; then
        build_with_host_tools
      else
        die "ROOTFS_BUILD_DRIVER=host requested, but virt-customize is not available."
      fi
      ;;
    docker)
      build_with_docker
      ;;
    auto)
      # GitHub-hosted runners often have libguestfs tooling installed but fail
      # later inside supermin. Prefer the Dockerized Debian/libguestfs toolchain
      # in CI, while keeping host builds for local Linux machines.
      if [ "${GITHUB_ACTIONS:-}" = "true" ] && command -v docker >/dev/null 2>&1; then
        build_with_docker
      elif command -v virt-customize >/dev/null 2>&1; then
        build_with_host_tools
      else
        build_with_docker
      fi
      ;;
  esac
else
  echo "SKIP_BUILD=1 set; reusing ${IMAGE}"
  [ -f "${IMAGE}" ] || die "SKIP_BUILD=1 requested, but rootfs image is missing: ${IMAGE}"
fi

if [ "${SKIP_UPLOAD}" = "1" ]; then
  echo "SKIP_UPLOAD=1 set; image ready at ${IMAGE}"
  echo "Upload later with: SKIP_BUILD=1 rootfs/build-rootfs.sh"
  exit 0
fi

ROOTFS_ITEM_HASH="$(upload_image)"
write_manifest "${ROOTFS_ITEM_HASH}"
