#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="${OUT_DIR:-${SCRIPT_DIR}/../dist-rootfs}"
BASE_URL="${BASE_URL:-https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-amd64.qcow2}"
BASE_IMAGE="${OUT_DIR}/debian-12-genericcloud-amd64.qcow2"
IMAGE="${OUT_DIR}/aleph-playwright-runner.qcow2"
ROOTFS_IMAGE_SIZE="${ROOTFS_IMAGE_SIZE:-20G}"
PLAYWRIGHT_VERSION="${PLAYWRIGHT_VERSION:-1.61.1}"
HOST_UID="${HOST_UID:-}"
HOST_GID="${HOST_GID:-}"
ROOTFS_SPARSIFY_TMPDIR=""

require() {
  command -v "$1" >/dev/null 2>&1 || { echo "Missing required command: $1" >&2; exit 1; }
}

for command in curl qemu-img virt-customize; do require "${command}"; done
test "${PLAYWRIGHT_VERSION}" = "1.61.1" || {
  echo "playwright-runner only supports Playwright 1.61.1" >&2
  exit 1
}

cleanup() {
  if [ -n "${ROOTFS_SPARSIFY_TMPDIR}" ] && [ -d "${ROOTFS_SPARSIFY_TMPDIR}" ]; then
    rm -rf "${ROOTFS_SPARSIFY_TMPDIR}"
  fi
}
trap cleanup EXIT

mkdir -p "${OUT_DIR}"
if [ ! -f "${BASE_IMAGE}" ]; then
  curl --fail --show-error --location --retry 5 --retry-all-errors \
    --connect-timeout 20 --max-time 300 "${BASE_URL}" -o "${BASE_IMAGE}"
fi

cp "${BASE_IMAGE}" "${IMAGE}"
qemu-img resize "${IMAGE}" "${ROOTFS_IMAGE_SIZE}"

virt-customize \
  -a "${IMAGE}" \
  --network \
  --mkdir /opt/playwright-runner \
  --mkdir /etc/playwright-runner \
  --mkdir /etc/systemd/journald.conf.d \
  --mkdir /var/lib/playwright-runner \
  --copy-in "${SCRIPT_DIR}/Caddyfile:/etc/playwright-runner" \
  --copy-in "${SCRIPT_DIR}/playwright-runner-bootstrap.sh:/usr/local/sbin" \
  --copy-in "${SCRIPT_DIR}/playwright-runner.service:/etc/systemd/system" \
  --copy-in "${SCRIPT_DIR}/playwright-runner-proxy.service:/etc/systemd/system" \
  --copy-in "${SCRIPT_DIR}/playwright-runner-bootstrap.service:/etc/systemd/system" \
  --copy-in "${SCRIPT_DIR}/playwright-runner-ttl.service:/etc/systemd/system" \
  --copy-in "${SCRIPT_DIR}/playwright-runner-ttl.timer:/etc/systemd/system" \
  --run-command "apt-get update && apt-get install -y --no-install-recommends ca-certificates caddy curl gnupg" \
  --run-command "curl -fsSL https://deb.nodesource.com/setup_24.x | bash -" \
  --run-command "apt-get install -y --no-install-recommends nodejs" \
  --run-command "useradd --system --home /var/lib/playwright-runner --shell /usr/sbin/nologin playwright-runner" \
  --run-command "useradd --system --home /var/lib/playwright-runner --shell /usr/sbin/nologin playwright-proxy" \
  --run-command "cd /opt/playwright-runner && npm init -y && npm install --omit=dev playwright@${PLAYWRIGHT_VERSION}" \
  --run-command "cd /opt/playwright-runner && ./node_modules/.bin/playwright install --with-deps chromium" \
  --run-command "chown -R playwright-runner:playwright-runner /opt/playwright-runner /var/lib/playwright-runner" \
  --run-command "chown -R root:playwright-proxy /etc/playwright-runner && chmod 0750 /etc/playwright-runner" \
  --run-command "chmod 0755 /usr/local/sbin/playwright-runner-bootstrap.sh" \
  --run-command "printf '[Journal]\\nSystemMaxUse=128M\\nRuntimeMaxUse=64M\\nMaxRetentionSec=2day\\n' >/etc/systemd/journald.conf.d/playwright-runner.conf" \
  --run-command "systemctl enable playwright-runner-bootstrap.service"

if command -v virt-sparsify >/dev/null 2>&1; then
  SPARSE_IMAGE="${IMAGE%.qcow2}.sparse.qcow2"
  ROOTFS_SPARSIFY_TMPDIR="$(mktemp -d "${OUT_DIR}/virt-sparsify-tmp.XXXXXX")"
  TMPDIR="${ROOTFS_SPARSIFY_TMPDIR}" virt-sparsify --check-tmpdir=continue --compress \
    "${IMAGE}" "${SPARSE_IMAGE}"
  mv "${SPARSE_IMAGE}" "${IMAGE}"
fi

if [ -n "${HOST_UID}" ] && [ -n "${HOST_GID}" ]; then
  chown -R "${HOST_UID}:${HOST_GID}" "${OUT_DIR}"
fi

echo "Playwright ${PLAYWRIGHT_VERSION} RootFS ready: ${IMAGE}"
