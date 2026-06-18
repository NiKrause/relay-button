#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
PROJECT_DIR="${PROJECT_DIR:-$(cd "${SCRIPT_DIR}/../../../../.." && pwd)}"
OUT_DIR="${OUT_DIR:-${APP_DIR}/dist-rootfs}"
ROOTFS_CONTRACT_FILE="${ROOTFS_CONTRACT_FILE:-${PROJECT_DIR}/root-profiles/ucan-store.json}"
ROOTFS_BUILD_DRIVER="${ROOTFS_BUILD_DRIVER:-auto}"
ROOTFS_SIZE_MIB="${ROOTFS_SIZE_MIB:-20480}"
ROOTFS_IMAGE_SIZE="${ROOTFS_IMAGE_SIZE:-20G}"
ROOTFS_VERSION="${ROOTFS_VERSION:-}"
CHANNEL="${CHANNEL:-ALEPH-CLOUDSOLUTIONS}"
SKIP_UPLOAD="${SKIP_UPLOAD:-0}"
SKIP_BUILD="${SKIP_BUILD:-0}"
IPFS_ADD_URL="${IPFS_ADD_URL:-https://ipfs.aleph.cloud/api/v0/add}"
ROOTFS_CID=""
ROOTFS_ITEM_HASH=""

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
  require python3
  [ -f "${ROOTFS_CONTRACT_FILE}" ] || die "Rootfs contract does not exist: ${ROOTFS_CONTRACT_FILE}"
  eval "$(python3 "${SCRIPT_DIR}/read-rootfs-contract.py" "${ROOTFS_CONTRACT_FILE}")"

  if [ "${ROOTFS_CONTRACT_PROFILE}" != "ucan-store" ]; then
    die "Only the ucan-store rootfs profile is supported, got: ${ROOTFS_CONTRACT_PROFILE}"
  fi
  if [ "${ROOTFS_CONTRACT_INSTALL_MODE}" != "prebaked" ]; then
    die "Only prebaked install mode is supported, got: ${ROOTFS_CONTRACT_INSTALL_MODE}"
  fi
}

resolve_rootfs_version() {
  if [ -n "${ROOTFS_VERSION}" ]; then
    printf '%s\n' "${ROOTFS_VERSION}"
    return
  fi

  if [ -d "${PROJECT_DIR}/.git" ]; then
    local short_sha
    short_sha="$(git -C "${PROJECT_DIR}" rev-parse --short HEAD)"
    local build_date
    build_date="$(date -u +%Y%m%d)"
    printf 'ucan-store-git-%s-%s\n' "${build_date}" "${short_sha}"
    return
  fi

  printf 'ucan-store-v0.1.0\n'
}

build_with_host_tools() {
  echo "Using host virt-customize/qemu-img toolchain."
  ROOTFS_CONTRACT_FILE="${ROOTFS_CONTRACT_FILE}" \
  OUT_DIR="${OUT_DIR}" \
  ROOTFS_IMAGE_SIZE="${ROOTFS_IMAGE_SIZE}" \
  PROJECT_DIR="${PROJECT_DIR}" \
  bash "${SCRIPT_DIR}/build-rootfs-image.sh"
}

build_with_docker() {
  require docker

  if ! docker info >/dev/null 2>&1; then
    die "Docker is installed, but the Docker daemon is not running."
  fi

  echo "Using Dockerized Debian/libguestfs builder."
  docker build --platform linux/amd64 \
    -t ucan-store-rootfs-builder:local \
    -f "${SCRIPT_DIR}/Dockerfile.rootfs" \
    "${SCRIPT_DIR}"

  docker run --rm --privileged --platform linux/amd64 \
    -e LIBGUESTFS_BACKEND=direct \
    -e ROOTFS_CONTRACT_FILE=/workspace/shared-rootfs/input-rootfs-contract.json \
    -e OUT_DIR=/workspace/ucan-store/dist-rootfs \
    -e ROOTFS_IMAGE_SIZE="${ROOTFS_IMAGE_SIZE}" \
    -e PROJECT_DIR=/workspace/ucan-store \
    -v "${PROJECT_DIR}:/workspace/ucan-store" \
    -v "${SCRIPT_DIR}:/workspace/shared-rootfs" \
    -v "${ROOTFS_CONTRACT_FILE}:/workspace/shared-rootfs/input-rootfs-contract.json:ro" \
    -w /workspace/shared-rootfs \
    ucan-store-rootfs-builder:local \
    /bin/bash /workspace/shared-rootfs/build-rootfs-image.sh
}

sync_manifest_copy_target() {
  local manifest_path="${OUT_DIR}/rootfs-manifest.json"
  local copy_target="${ROOTFS_CONTRACT_MANIFEST_COPY_TARGET:-}"
  local resolved_target
  local target_dir
  local versioned_target

  [ -n "${copy_target}" ] || return 0
  [ -f "${manifest_path}" ] || die "Manifest does not exist: ${manifest_path}"

  if [[ "${copy_target}" = /* ]]; then
    resolved_target="${copy_target}"
  else
    resolved_target="${PROJECT_DIR}/${copy_target}"
  fi

  target_dir="$(dirname "${resolved_target}")"
  mkdir -p "${target_dir}"
  cp "${manifest_path}" "${resolved_target}"

  versioned_target="${target_dir}/${ROOTFS_VERSION}.json"
  cp "${manifest_path}" "${versioned_target}"

  echo "Copied rootfs manifest to ${resolved_target}"
  echo "Copied versioned rootfs manifest to ${versioned_target}"
}

write_manifest() {
  local rootfs_cid="${1:-}"
  local rootfs_item_hash="${2:-}"
  local rootfs_source_size_bytes=""

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

  {
    echo '{'
    echo '  "profile": "ucan-store",'
    echo "  \"version\": \"${ROOTFS_VERSION}\","
    echo '  "rootfsInstallStrategy": "prebaked",'
    echo '  "requiresBootstrapNetwork": false,'
    echo '  "bootstrapSummary": "Node.js, Caddy, and the current local upload service runtime are prebaked into the image.",'
    if [[ "${rootfs_source_size_bytes}" =~ ^[0-9]+$ ]]; then
      echo "  \"rootfsSourceSizeBytes\": ${rootfs_source_size_bytes},"
    fi
    printf '  "requiredPortForwards": %s,\n' "${ROOTFS_CONTRACT_PORT_FORWARDS_JSON}"
    if [ -n "${rootfs_cid}" ]; then
      echo "  \"rootfsCid\": \"${rootfs_cid}\","
    fi
    if [ -n "${rootfs_item_hash}" ]; then
      echo "  \"rootfsItemHash\": \"${rootfs_item_hash}\","
    fi
    echo "  \"rootfsSizeMiB\": ${ROOTFS_SIZE_MIB},"
    echo "  \"createdAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
    printf '  "notes": "%s"\n' "${ROOTFS_CONTRACT_MANIFEST_NOTES}"
    echo '}'
  } > "${OUT_DIR}/rootfs-manifest.json"

  echo "Rootfs manifest written to ${OUT_DIR}/rootfs-manifest.json"
  sync_manifest_copy_target
}

upload_rootfs_to_ipfs() {
  require curl
  [ -f "${OUT_DIR}/aleph-ucan-store.qcow2" ] || die "Missing rootfs image: ${OUT_DIR}/aleph-ucan-store.qcow2"

  curl --fail --show-error --silent \
    -X POST \
    -F "file=@${OUT_DIR}/aleph-ucan-store.qcow2" \
    "${IPFS_ADD_URL}" | tee "${OUT_DIR}/ipfs-add-response.jsonl" >/dev/null

  ROOTFS_CID="$(python3 - "${OUT_DIR}/ipfs-add-response.jsonl" <<'PY'
import json
import sys
from pathlib import Path

lines = [line for line in Path(sys.argv[1]).read_text().splitlines() if line.strip()]
if not lines:
    raise SystemExit("No IPFS add response lines found")
payload = json.loads(lines[-1])
cid = payload.get("Hash")
if not isinstance(cid, str) or not cid.strip():
    raise SystemExit("IPFS add response is missing Hash")
print(cid.strip())
PY
)"

  echo "Uploaded rootfs to IPFS with CID ${ROOTFS_CID}"
}

publish_store_message() {
  [ -n "${ROOTFS_CID}" ] || die "Cannot publish rootfs STORE message without ROOTFS_CID"
  die "Aleph STORE message publication is not wired for the shared ucan-store rootfs yet. Re-run with SKIP_UPLOAD=1 until the publication workflow is implemented."
}

load_rootfs_contract
ROOTFS_VERSION="$(resolve_rootfs_version)"

mkdir -p "${OUT_DIR}"

if [ "${SKIP_BUILD}" != "1" ]; then
  case "${ROOTFS_BUILD_DRIVER}" in
    host)
      build_with_host_tools
      ;;
    docker)
      build_with_docker
      ;;
    auto)
      if command -v virt-customize >/dev/null 2>&1 && command -v qemu-img >/dev/null 2>&1; then
        build_with_host_tools
      else
        build_with_docker
      fi
      ;;
    *)
      die "Unsupported ROOTFS_BUILD_DRIVER=${ROOTFS_BUILD_DRIVER}"
      ;;
  esac
fi

if [ "${SKIP_UPLOAD}" != "1" ]; then
  upload_rootfs_to_ipfs
  publish_store_message
fi

write_manifest "${ROOTFS_CID}" "${ROOTFS_ITEM_HASH}"
