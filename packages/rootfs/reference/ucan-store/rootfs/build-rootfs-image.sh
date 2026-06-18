#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${PROJECT_DIR:-$(cd "${SCRIPT_DIR}/../../../../.." && pwd)}"
ROOTFS_CONTRACT_FILE="${ROOTFS_CONTRACT_FILE:-${PROJECT_DIR}/root-profiles/ucan-store.json}"
OUT_DIR="${OUT_DIR:-${PROJECT_DIR}/dist-rootfs}"
BASE_URL="${BASE_URL:-https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-amd64.qcow2}"
BASE_IMAGE="${OUT_DIR}/debian-12-genericcloud-amd64.qcow2"
IMAGE="${OUT_DIR}/aleph-ucan-store.qcow2"
APP_TAR="${OUT_DIR}/ucan-store-runtime.tar"
ROOTFS_IMAGE_SIZE="${ROOTFS_IMAGE_SIZE:-20G}"
ROOTFS_SPARSIFY="${ROOTFS_SPARSIFY:-1}"
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
require tar

eval "$(python3 "${SCRIPT_DIR}/read-rootfs-contract.py" "${ROOTFS_CONTRACT_FILE}")"

if [ "${ROOTFS_CONTRACT_PROFILE}" != "ucan-store" ]; then
  echo "Only the ucan-store rootfs profile is supported, got: ${ROOTFS_CONTRACT_PROFILE}" >&2
  exit 1
fi
if [ "${ROOTFS_CONTRACT_INSTALL_MODE}" != "prebaked" ]; then
  echo "Only prebaked install mode is supported, got: ${ROOTFS_CONTRACT_INSTALL_MODE}" >&2
  exit 1
fi
if [ ! -d "${PROJECT_DIR}/local-storacha-api" ]; then
  echo "Missing local-storacha-api directory: ${PROJECT_DIR}/local-storacha-api" >&2
  exit 1
fi
if [ ! -f "${PROJECT_DIR}/web/package.json" ]; then
  echo "Missing web/package.json: ${PROJECT_DIR}/web/package.json" >&2
  exit 1
fi
if [ ! -f "${PROJECT_DIR}/web/package-lock.json" ]; then
  echo "Missing web/package-lock.json: ${PROJECT_DIR}/web/package-lock.json" >&2
  echo "The current ucan-store rootfs scaffold expects the upload wall web app to use npm lockfiles." >&2
  exit 1
fi

mkdir -p "${OUT_DIR}"

echo "Building ucan-store image in prebaked mode"

if [ ! -f "${BASE_IMAGE}" ]; then
  echo "Downloading base image from ${BASE_URL}"
  curl --fail --show-error --location \
    --retry 5 \
    --retry-all-errors \
    --retry-delay 5 \
    --connect-timeout 20 \
    --max-time 300 \
    "${BASE_URL}" -o "${BASE_IMAGE}"
fi

cp "${BASE_IMAGE}" "${IMAGE}"
qemu-img resize "${IMAGE}" "${ROOTFS_IMAGE_SIZE}"

tar \
  --exclude ".git" \
  -C "${PROJECT_DIR}" \
  -cf "${APP_TAR}" \
  local-storacha-api \
  web/package.json \
  web/package-lock.json \
  README.md

virt-customize \
  -a "${IMAGE}" \
  --mkdir "${ROOTFS_CONTRACT_INSTALL_DIR}" \
  --mkdir "${ROOTFS_CONTRACT_DATA_DIR}" \
  --copy-in "${APP_TAR}:/opt" \
  --copy-in "${SCRIPT_DIR}/ucan-store-bootstrap.sh:/usr/local/sbin" \
  --copy-in "${SCRIPT_DIR}/ucan-store-configure.sh:/usr/local/sbin" \
  --copy-in "${SCRIPT_DIR}/ucan-store-describe.py:/usr/local/sbin" \
  --copy-in "${SCRIPT_DIR}/ucan-store-setup-server.py:/usr/local/sbin" \
  --copy-in "${SCRIPT_DIR}/ucan-store-bootstrap.service:/etc/systemd/system" \
  --copy-in "${SCRIPT_DIR}/ucan-store-autotls-refresh.service:/etc/systemd/system" \
  --copy-in "${SCRIPT_DIR}/ucan-store.service:/etc/systemd/system" \
  --run-command "tar -xf /opt/$(basename "${APP_TAR}") -C ${ROOTFS_CONTRACT_INSTALL_DIR}" \
  --run-command "chmod 0755 /usr/local/sbin/ucan-store-bootstrap.sh" \
  --run-command "chmod 0755 /usr/local/sbin/ucan-store-configure.sh" \
  --run-command "chmod 0755 /usr/local/sbin/ucan-store-describe.py" \
  --run-command "chmod 0755 /usr/local/sbin/ucan-store-setup-server.py" \
  --run-command "INSTALL_DIR=${ROOTFS_CONTRACT_INSTALL_DIR} DATA_DIR=${ROOTFS_CONTRACT_DATA_DIR} ENV_FILE=${ROOTFS_CONTRACT_ENV_FILE} SERVICE_USER=ucan-store APP_BINARY=${ROOTFS_CONTRACT_BINARY_PATH} /usr/local/sbin/ucan-store-bootstrap.sh all" \
  --run-command "systemctl enable ${ROOTFS_CONTRACT_BOOTSTRAP_SERVICE}" \
  --run-command "systemctl enable ${ROOTFS_CONTRACT_AUTOTLS_SERVICE}" \
  --run-command "systemctl enable ${ROOTFS_CONTRACT_MAIN_SERVICE}" \
  --run-command "rm -f /opt/$(basename "${APP_TAR}")"

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
