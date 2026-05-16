#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ALEPH_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
OUT_DIR="${OUT_DIR:-${ALEPH_DIR}/dist-rootfs}"
ROOTFS_CONTRACT_FILE="${ROOTFS_CONTRACT_FILE:-${ALEPH_DIR}/root-profiles/uc-go-peer.json}"
ROOTFS_BUILD_DRIVER="${ROOTFS_BUILD_DRIVER:-auto}"
ROOTFS_SIZE_MIB="${ROOTFS_SIZE_MIB:-20480}"
ROOTFS_IMAGE_SIZE="${ROOTFS_IMAGE_SIZE:-20G}"
ROOTFS_VERSION="${ROOTFS_VERSION:-}"
CHANNEL="${CHANNEL:-ALEPH-CLOUDSOLUTIONS}"
SKIP_UPLOAD="${SKIP_UPLOAD:-0}"
SKIP_BUILD="${SKIP_BUILD:-0}"
IPFS_ADD_URL="${IPFS_ADD_URL:-https://ipfs.aleph.cloud/api/v0/add}"
IPFS_GATEWAY_URL="${IPFS_GATEWAY_URL:-https://ipfs.aleph.cloud/ipfs}"
ALEPH_API_HOST="${ALEPH_API_HOST:-https://api2.aleph.im}"
ALEPH_MESSAGE_WAIT_ATTEMPTS="${ALEPH_MESSAGE_WAIT_ATTEMPTS:-60}"
ALEPH_MESSAGE_WAIT_DELAY_SECONDS="${ALEPH_MESSAGE_WAIT_DELAY_SECONDS:-5}"
ALEPH_PIN_ATTEMPTS="${ALEPH_PIN_ATTEMPTS:-4}"
ALEPH_PIN_DELAY_SECONDS="${ALEPH_PIN_DELAY_SECONDS:-10}"
IPFS_GATEWAY_WAIT_ATTEMPTS="${IPFS_GATEWAY_WAIT_ATTEMPTS:-30}"
IPFS_GATEWAY_WAIT_DELAY_SECONDS="${IPFS_GATEWAY_WAIT_DELAY_SECONDS:-10}"
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

  if [ "${ROOTFS_CONTRACT_PROFILE}" != "uc-go-peer" ]; then
    die "Only the uc-go-peer rootfs profile is supported, got: ${ROOTFS_CONTRACT_PROFILE}"
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
    printf 'uc-go-peer-git-%s-%s\n' "${build_date}" "${short_sha}"
    return
  fi

  printf 'uc-go-peer-v0.1.0\n'
}

resolve_aleph_bin() {
  if [ -n "${ALEPH_BIN:-}" ]; then
    printf '%s\n' "${ALEPH_BIN}"
    return
  fi

  if command -v aleph >/dev/null 2>&1; then
    command -v aleph
    return
  fi

  die "Missing aleph CLI. Set ALEPH_BIN=/path/to/aleph or install aleph-client."
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
    -t uc-go-peer-rootfs-builder:local \
    -f "${SCRIPT_DIR}/Dockerfile.rootfs" \
    "${SCRIPT_DIR}"

  docker run --rm --privileged --platform linux/amd64 \
    -e LIBGUESTFS_BACKEND=direct \
    -e ROOTFS_CONTRACT_FILE=/workspace/universal-connectivity/go-peer/aleph/root-profiles/uc-go-peer.json \
    -e OUT_DIR=/workspace/universal-connectivity/go-peer/aleph/dist-rootfs \
    -e ROOTFS_IMAGE_SIZE="${ROOTFS_IMAGE_SIZE}" \
    -e PROJECT_DIR=/workspace/universal-connectivity \
    -v "${PROJECT_DIR}:/workspace/universal-connectivity" \
    -v "${SCRIPT_DIR}:/workspace/shared-rootfs" \
    -w /workspace/shared-rootfs \
    uc-go-peer-rootfs-builder:local \
    /bin/bash /workspace/shared-rootfs/build-rootfs-image.sh
}

sync_manifest_copy_target() {
  local manifest_path="${OUT_DIR}/rootfs-manifest.json"
  local copy_target="${ROOTFS_CONTRACT_MANIFEST_COPY_TARGET:-}"
  local resolved_target
  local target_dir
  local target_ext
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

  target_ext=".json"
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
    echo '  "profile": "uc-go-peer",'
    echo "  \"version\": \"${ROOTFS_VERSION}\","
    echo '  "rootfsInstallStrategy": "prebaked",'
    echo '  "requiresBootstrapNetwork": false,'
    echo '  "bootstrapSummary": "Dependencies are preinstalled in the image.",'
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

wait_for_aleph_message_processed() {
  require python3
  require curl

  local item_hash="${1:?missing item hash}"
  local attempts="${2:-${ALEPH_MESSAGE_WAIT_ATTEMPTS}}"
  local delay_seconds="${3:-${ALEPH_MESSAGE_WAIT_DELAY_SECONDS}}"
  local api_host="${4:-${ALEPH_API_HOST}}"
  local response_file
  response_file="$(mktemp)"

  local attempt
  for attempt in $(seq 1 "${attempts}"); do
    if ! curl --fail --silent --show-error \
      "${api_host}/api/v0/messages/${item_hash}" \
      > "${response_file}"; then
      rm -f "${response_file}"
      die "Failed to query Aleph message status for ${item_hash}"
    fi

    local status
    status="$(python3 - "${response_file}" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
status = payload.get("status")
print(status or "")
PY
)"

    case "${status}" in
      processed)
        rm -f "${response_file}"
        return 0
        ;;
      rejected)
        local rejection_summary
        rejection_summary="$(python3 - "${response_file}" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
error_code = payload.get("error_code")
details = payload.get("details")
first_error = details.get("errors", [None])[0] if isinstance(details, dict) else None
if error_code == 5 and isinstance(first_error, dict):
    account_balance = first_error.get("account_balance")
    required_balance = first_error.get("required_balance")
    if account_balance is not None and required_balance is not None:
        print(f"insufficient Aleph balance: account has {account_balance}, required is {required_balance}")
        raise SystemExit(0)
if error_code is None:
    print(json.dumps(details or {}))
else:
    print(f"error {error_code}: {json.dumps(details or {})}")
PY
)"
        rm -f "${response_file}"
        die "Aleph STORE message ${item_hash} was rejected: ${rejection_summary}"
        ;;
      "")
        ;;
      *)
        ;;
    esac

    if [ "${attempt}" -lt "${attempts}" ]; then
      sleep "${delay_seconds}"
    fi
  done

  rm -f "${response_file}"
  die "Aleph STORE message ${item_hash} did not become processed after ${attempts} attempts."
}

wait_for_ipfs_cid_available() {
  require curl

  local cid="${1:?missing cid}"
  local attempts="${2:-${IPFS_GATEWAY_WAIT_ATTEMPTS}}"
  local delay_seconds="${3:-${IPFS_GATEWAY_WAIT_DELAY_SECONDS}}"
  local gateway_base="${4:-${IPFS_GATEWAY_URL}}"
  local gateway_url="${gateway_base%/}/${cid}"
  local headers_file
  headers_file="$(mktemp)"

  local attempt
  for attempt in $(seq 1 "${attempts}"); do
    : > "${headers_file}"
    if curl --silent --show-error --location \
      --range 0-0 \
      --dump-header "${headers_file}" \
      --output /dev/null \
      "${gateway_url}"; then
      local http_status
      http_status="$(python3 - "${headers_file}" <<'PY'
import sys
from pathlib import Path

status_lines = []
for line in Path(sys.argv[1]).read_text(errors="replace").splitlines():
    if line.startswith("HTTP/"):
        status_lines.append(line)

if not status_lines:
    print("")
else:
    print(status_lines[-1].split()[1])
PY
)"

      case "${http_status}" in
        200|206)
          rm -f "${headers_file}"
          return 0
          ;;
      esac
    fi

    if [ "${attempt}" -lt "${attempts}" ]; then
      echo "CID ${cid} is not retrievable from ${gateway_base} yet (attempt ${attempt}/${attempts}); retrying in ${delay_seconds}s..." >&2
      sleep "${delay_seconds}"
    fi
  done

  rm -f "${headers_file}"
  die "CID ${cid} did not become retrievable from ${gateway_base} after ${attempts} attempts."
}

upload_image() {
  local aleph_bin
  aleph_bin="$(resolve_aleph_bin)"

  require python3
  require curl

  local image="${OUT_DIR}/aleph-uc-go-peer.qcow2"
  [ -f "${image}" ] || die "Rootfs image does not exist: ${image}"

  echo "Uploading ${image} to IPFS via ${IPFS_ADD_URL}..."
  : > "${OUT_DIR}/ipfs-add-response.jsonl"
  if ! curl --fail --silent --show-error \
    -X POST \
    -F "file=@${image}" \
    "${IPFS_ADD_URL}" \
    > "${OUT_DIR}/ipfs-add-response.jsonl"; then
    die "IPFS upload failed for ${image}"
  fi

  ROOTFS_CID="$(python3 - "${OUT_DIR}/ipfs-add-response.jsonl" <<'PY'
import json
import sys
from pathlib import Path

lines = [line for line in Path(sys.argv[1]).read_text().splitlines() if line.strip()]
if not lines:
    raise SystemExit("No response received from the IPFS add endpoint")

payload = json.loads(lines[-1])
cid = payload.get("Hash")
if not cid:
    raise SystemExit(f"IPFS add response did not include a Hash: {payload}")

print(cid)
PY
)" || die "Failed to extract CID from ${OUT_DIR}/ipfs-add-response.jsonl"

  echo "Waiting for CID ${ROOTFS_CID} to become retrievable via ${IPFS_GATEWAY_URL}..."
  wait_for_ipfs_cid_available "${ROOTFS_CID}"

  echo "Pinning CID ${ROOTFS_CID} on Aleph Cloud..."
  local attempt
  local stderr_log="${OUT_DIR}/store-message.stderr.log"
  local stdout_log="${OUT_DIR}/store-message.json"
  local last_error_summary=""

  for attempt in $(seq 1 "${ALEPH_PIN_ATTEMPTS}"); do
    : > "${stdout_log}"
    : > "${stderr_log}"

    echo "Aleph pin attempt ${attempt}/${ALEPH_PIN_ATTEMPTS} for CID ${ROOTFS_CID}..."
    if "${aleph_bin}" file pin "${ROOTFS_CID}" \
      --channel "${CHANNEL}" \
      > "${stdout_log}" 2> "${stderr_log}"; then
      break
    fi

    last_error_summary="$(python3 - "${stderr_log}" <<'PY'
import sys
from pathlib import Path

text = Path(sys.argv[1]).read_text(errors="replace").strip()
print(text or "Aleph pin failed without stderr output")
PY
)"

    echo "Aleph pin attempt ${attempt}/${ALEPH_PIN_ATTEMPTS} failed for CID ${ROOTFS_CID}." >&2
    if [[ -n "${last_error_summary}" ]]; then
      echo "${last_error_summary}" >&2
    fi

    if [ "${attempt}" -lt "${ALEPH_PIN_ATTEMPTS}" ]; then
      echo "Retrying Aleph pin in ${ALEPH_PIN_DELAY_SECONDS}s..." >&2
      sleep "${ALEPH_PIN_DELAY_SECONDS}"
      continue
    fi

    die "Aleph pin failed for CID ${ROOTFS_CID} after ${ALEPH_PIN_ATTEMPTS} attempts"
  done

  if [ ! -s "${stdout_log}" ]; then
    if [ -n "${last_error_summary}" ]; then
      echo "${last_error_summary}" >&2
    fi
    die "Aleph pin returned an empty response for CID ${ROOTFS_CID}"
  fi

  ROOTFS_ITEM_HASH="$(python3 - "${stdout_log}" <<'PY'
import json
import sys
from pathlib import Path

content = Path(sys.argv[1]).read_text().strip()
if not content:
    raise SystemExit("Aleph pin returned an empty response")

payload = json.loads(content)
print(payload["item_hash"])
PY
)" || die "Failed to extract Aleph item hash from ${OUT_DIR}/store-message.json"

  wait_for_aleph_message_processed "${ROOTFS_ITEM_HASH}"

  echo "Published rootfs CID: ${ROOTFS_CID}"
  echo "Published Aleph item hash: ${ROOTFS_ITEM_HASH}"
}

mkdir -p "${OUT_DIR}"
load_rootfs_contract
ROOTFS_VERSION="$(resolve_rootfs_version)"

echo "Building rootfs profile: uc-go-peer"
echo "Using install mode: prebaked"

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
      if [ "${GITHUB_ACTIONS:-}" = "true" ] && command -v docker >/dev/null 2>&1; then
        build_with_docker
      elif command -v virt-customize >/dev/null 2>&1; then
        build_with_host_tools
      else
        build_with_docker
      fi
      ;;
    *)
      die "Unsupported ROOTFS_BUILD_DRIVER: ${ROOTFS_BUILD_DRIVER}"
      ;;
  esac
else
  [ -f "${OUT_DIR}/aleph-uc-go-peer.qcow2" ] || die "SKIP_BUILD=1 requested, but image is missing."
fi

if [ "${SKIP_UPLOAD}" = "1" ]; then
  write_manifest
  echo "SKIP_UPLOAD=1 set; image ready at ${OUT_DIR}/aleph-uc-go-peer.qcow2"
  exit 0
fi

upload_image
write_manifest "${ROOTFS_CID}" "${ROOTFS_ITEM_HASH}"
