#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ALEPH_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
PROJECT_DIR="${PROJECT_DIR:-$(cd "${SCRIPT_DIR}/../../.." && pwd)}"
ROOTFS_CONTRACT_FILE="${ROOTFS_CONTRACT_FILE:-${ALEPH_DIR}/root-profiles/uc-go-peer.json}"
OUT_DIR="${OUT_DIR:-${ALEPH_DIR}/dist-rootfs}"
BASE_URL="${BASE_URL:-https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-amd64.qcow2}"
BASE_IMAGE="${OUT_DIR}/debian-12-genericcloud-amd64.qcow2"
IMAGE="${OUT_DIR}/aleph-uc-go-peer.qcow2"
APP_BINARY="${OUT_DIR}/universal-chat-go"
ROOTFS_IMAGE_SIZE="${ROOTFS_IMAGE_SIZE:-20G}"
ROOTFS_SPARSIFY="${ROOTFS_SPARSIFY:-1}"
ROOTFS_BUILD_TMPDIR=""
HOST_UID="${HOST_UID:-}"
HOST_GID="${HOST_GID:-}"

require() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

require curl
require qemu-img
require virt-customize
require python3
require go

cleanup() {
  if [ -n "${ROOTFS_BUILD_TMPDIR}" ] && [ -d "${ROOTFS_BUILD_TMPDIR}" ]; then
    chmod -R u+w "${ROOTFS_BUILD_TMPDIR}" 2>/dev/null || true
    rm -rf "${ROOTFS_BUILD_TMPDIR}"
  fi
}

trap cleanup EXIT

eval "$(python3 "${SCRIPT_DIR}/read-rootfs-contract.py" "${ROOTFS_CONTRACT_FILE}")"

ROOTFS_CONTRACT_BINARY_PATH="${ROOTFS_CONTRACT_BINARY_PATH:-/usr/local/bin/universal-chat-go}"
GUEST_APP_DIR="$(dirname "${ROOTFS_CONTRACT_BINARY_PATH}")"

if [ "${ROOTFS_CONTRACT_PROFILE}" != "uc-go-peer" ]; then
  echo "Only the uc-go-peer rootfs profile is supported, got: ${ROOTFS_CONTRACT_PROFILE}" >&2
  exit 1
fi
if [ "${ROOTFS_CONTRACT_INSTALL_MODE}" != "prebaked" ]; then
  echo "Only prebaked install mode is supported, got: ${ROOTFS_CONTRACT_INSTALL_MODE}" >&2
  exit 1
fi
if [ ! -d "${PROJECT_DIR}/go-peer" ]; then
  echo "Missing go-peer directory: ${PROJECT_DIR}/go-peer" >&2
  exit 1
fi

mkdir -p "${OUT_DIR}"

echo "Building uc-go-peer image in prebaked mode"

if [ ! -f "${BASE_IMAGE}" ]; then
  echo "Downloading base image from ${BASE_URL}"
  curl --fail --show-error --location     --retry 5     --retry-all-errors     --retry-delay 5     --connect-timeout 20     --max-time 300     "${BASE_URL}" -o "${BASE_IMAGE}"
fi

cp "${BASE_IMAGE}" "${IMAGE}"
qemu-img resize "${IMAGE}" "${ROOTFS_IMAGE_SIZE}"

echo "Building universal-chat-go outside the guest image"
ROOTFS_BUILD_TMPDIR="$(mktemp -d "${TMPDIR:-/tmp}/uc-go-peer-build.XXXXXX")"
(
  cd "${PROJECT_DIR}/go-peer"
  GOMODCACHE="${ROOTFS_BUILD_TMPDIR}/gomodcache" \
  GOCACHE="${ROOTFS_BUILD_TMPDIR}/gocache" \
  GOFLAGS="-modcacherw" \
  CGO_ENABLED=0 \
  go build -ldflags="-w -s" -o "${APP_BINARY}" .
)

virt-customize \
  -a "${IMAGE}" \
  --mkdir "${ROOTFS_CONTRACT_INSTALL_DIR}" \
  --mkdir "${ROOTFS_CONTRACT_DATA_DIR}" \
  --copy-in "${APP_BINARY}:${GUEST_APP_DIR}" \
  --copy-in "${SCRIPT_DIR}/uc-go-peer-bootstrap.sh:/usr/local/sbin" \
  --copy-in "${SCRIPT_DIR}/uc-go-peer-configure.sh:/usr/local/sbin" \
  --copy-in "${SCRIPT_DIR}/uc-go-peer-bootstrap-refresh.py:/usr/local/sbin" \
  --copy-in "${SCRIPT_DIR}/uc-go-peer-autotls-refresh.py:/usr/local/sbin" \
  --copy-in "${SCRIPT_DIR}/uc-go-peer-describe.py:/usr/local/sbin" \
  --copy-in "${SCRIPT_DIR}/uc-go-peer-setup-server.py:/usr/local/sbin" \
  --copy-in "${SCRIPT_DIR}/uc-go-peer-bootstrap.service:/etc/systemd/system" \
  --copy-in "${SCRIPT_DIR}/uc-go-peer-bootstrap-refresh.service:/etc/systemd/system" \
  --copy-in "${SCRIPT_DIR}/uc-go-peer-bootstrap-refresh.timer:/etc/systemd/system" \
  --copy-in "${SCRIPT_DIR}/uc-go-peer-autotls-refresh.service:/etc/systemd/system" \
  --copy-in "${SCRIPT_DIR}/uc-go-peer.service:/etc/systemd/system" \
  --run-command "chmod 0755 ${ROOTFS_CONTRACT_BINARY_PATH}" \
  --run-command "chmod 0755 /usr/local/sbin/uc-go-peer-bootstrap.sh" \
  --run-command "chmod 0755 /usr/local/sbin/uc-go-peer-configure.sh" \
  --run-command "chmod 0755 /usr/local/sbin/uc-go-peer-bootstrap-refresh.py" \
  --run-command "chmod 0755 /usr/local/sbin/uc-go-peer-autotls-refresh.py" \
  --run-command "chmod 0755 /usr/local/sbin/uc-go-peer-describe.py" \
  --run-command "chmod 0755 /usr/local/sbin/uc-go-peer-setup-server.py" \
  --run-command "INSTALL_DIR=${ROOTFS_CONTRACT_INSTALL_DIR} APP_BINARY=${ROOTFS_CONTRACT_BINARY_PATH} DATA_DIR=${ROOTFS_CONTRACT_DATA_DIR} ENV_FILE=${ROOTFS_CONTRACT_ENV_FILE} SERVICE_USER=uc-go-peer /usr/local/sbin/uc-go-peer-bootstrap.sh base" \
  --run-command "INSTALL_DIR=${ROOTFS_CONTRACT_INSTALL_DIR} APP_BINARY=${ROOTFS_CONTRACT_BINARY_PATH} DATA_DIR=${ROOTFS_CONTRACT_DATA_DIR} ENV_FILE=${ROOTFS_CONTRACT_ENV_FILE} SERVICE_USER=uc-go-peer /usr/local/sbin/uc-go-peer-bootstrap.sh build" \
  --run-command "INSTALL_DIR=${ROOTFS_CONTRACT_INSTALL_DIR} APP_BINARY=${ROOTFS_CONTRACT_BINARY_PATH} DATA_DIR=${ROOTFS_CONTRACT_DATA_DIR} ENV_FILE=${ROOTFS_CONTRACT_ENV_FILE} SERVICE_USER=uc-go-peer /usr/local/sbin/uc-go-peer-bootstrap.sh finalize" \
  --run-command "systemctl enable ${ROOTFS_CONTRACT_BOOTSTRAP_SERVICE}" \
  --run-command "systemctl enable ${ROOTFS_CONTRACT_AUTOTLS_SERVICE}" \
  --run-command "systemctl enable ${ROOTFS_CONTRACT_MAIN_SERVICE}"

if [ "${ROOTFS_SPARSIFY}" = "1" ] && command -v virt-sparsify >/dev/null 2>&1; then
  SPARSE_IMAGE="${IMAGE%.qcow2}.sparse.qcow2"
  rm -f "${SPARSE_IMAGE}"
  echo "Sparsifying and compressing ${IMAGE}..."
  virt-sparsify --compress "${IMAGE}" "${SPARSE_IMAGE}"
  mv "${SPARSE_IMAGE}" "${IMAGE}"
fi

echo "Rootfs image ready at ${IMAGE}"

if [ -n "${HOST_UID}" ] && [ -n "${HOST_GID}" ]; then
  chown -R "${HOST_UID}:${HOST_GID}" "${OUT_DIR}"
fi
