#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="${OUT_DIR:-${SCRIPT_DIR}/../dist-rootfs}"
BASE_URL="${BASE_URL:-https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-amd64.qcow2}"
BASE_IMAGE="${OUT_DIR}/debian-12-genericcloud-amd64.qcow2"
IMAGE="${OUT_DIR}/aleph-github-runner.qcow2"
ROOTFS_IMAGE_SIZE="${ROOTFS_IMAGE_SIZE:-10G}"
# Pinned on purpose: the runner is started with --disableupdate, so the image
# decides the version. Bump both lines together.
RUNNER_VERSION="${RUNNER_VERSION:-2.338.0}"
RUNNER_SHA256="${RUNNER_SHA256:-af4b794c1bc41d73d40535e3fe092a39f9679cd8d965954c2aca25a05ca41d32}"
ETHERS_VERSION="6.16.0"
HOST_UID="${HOST_UID:-}"
HOST_GID="${HOST_GID:-}"
ROOTFS_SPARSIFY_TMPDIR=""

require() {
  command -v "$1" >/dev/null 2>&1 || { echo "Missing required command: $1" >&2; exit 1; }
}

for command in curl qemu-img virt-customize sha256sum; do require "${command}"; done

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

RUNNER_TARBALL="${OUT_DIR}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz"
if [ ! -f "${RUNNER_TARBALL}" ]; then
  curl --fail --show-error --location --retry 5 --retry-all-errors \
    --connect-timeout 20 --max-time 300 \
    "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz" \
    -o "${RUNNER_TARBALL}"
fi
echo "${RUNNER_SHA256}  ${RUNNER_TARBALL}" | sha256sum --check --strict

cp "${BASE_IMAGE}" "${IMAGE}"
qemu-img resize "${IMAGE}" "${ROOTFS_IMAGE_SIZE}"

virt-customize \
  -a "${IMAGE}" \
  --network \
  --mkdir /opt/actions-runner \
  --mkdir /opt/github-runner \
  --mkdir /etc/github-runner \
  --mkdir /etc/systemd/journald.conf.d \
  --mkdir /var/lib/github-runner \
  --copy-in "${RUNNER_TARBALL}:/opt/github-runner" \
  --copy-in "${SCRIPT_DIR}/forget-self.mjs:/opt/github-runner" \
  --copy-in "${SCRIPT_DIR}/github-runner-start:/usr/local/sbin" \
  --copy-in "${SCRIPT_DIR}/github-runner-finish:/usr/local/sbin" \
  --copy-in "${SCRIPT_DIR}/github-runner.service:/etc/systemd/system" \
  --copy-in "${SCRIPT_DIR}/github-runner-ttl.service:/etc/systemd/system" \
  --copy-in "${SCRIPT_DIR}/github-runner-ttl.timer:/etc/systemd/system" \
  --run-command "apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gnupg git jq unzip zip xz-utils zstd sudo python3 rsync e2fsprogs openssh-client qemu-utils cryptsetup debootstrap docker.io" \
  --run-command "curl -fsSL https://deb.nodesource.com/setup_24.x | bash -" \
  --run-command "apt-get install -y --no-install-recommends nodejs" \
  --run-command "useradd --create-home --home-dir /home/runner --shell /bin/bash --groups docker runner" \
  --run-command "printf 'runner ALL=(ALL) NOPASSWD:ALL\\n' >/etc/sudoers.d/runner && chmod 0440 /etc/sudoers.d/runner" \
  --run-command "tar -xzf /opt/github-runner/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz -C /opt/actions-runner && rm /opt/github-runner/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz" \
  --run-command "/opt/actions-runner/bin/installdependencies.sh" \
  --run-command "chown -R runner:runner /opt/actions-runner /var/lib/github-runner" \
  --run-command "cd /opt/github-runner && npm init -y >/dev/null && npm install --omit=dev --no-audit --no-fund ethers@${ETHERS_VERSION}" \
  --run-command "chmod 0700 /etc/github-runner && chmod 0755 /usr/local/sbin/github-runner-start /usr/local/sbin/github-runner-finish" \
  --run-command "printf '[Journal]\\nSystemMaxUse=256M\\nRuntimeMaxUse=64M\\nMaxRetentionSec=2day\\n' >/etc/systemd/journald.conf.d/github-runner.conf" \
  --run-command "npm cache clean --force" \
  --run-command "apt-get clean && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/* /root/.npm /tmp/* /var/tmp/*" \
  --run-command "systemctl enable docker.service github-runner.service"

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

echo "Compressed RootFS size: $(stat -c '%s bytes' "${IMAGE}") ($(du -h "${IMAGE}" | cut -f1) on disk)"
echo "GitHub runner ${RUNNER_VERSION} RootFS ready: ${IMAGE}"
