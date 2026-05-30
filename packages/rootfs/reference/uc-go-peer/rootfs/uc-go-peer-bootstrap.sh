#!/usr/bin/env bash
set -euo pipefail
set -x

INSTALL_DIR="${INSTALL_DIR:-/opt/go-peer}"
SERVICE_USER="${SERVICE_USER:-uc-go-peer}"
DATA_DIR="${DATA_DIR:-/var/lib/uc-go-peer}"
ENV_FILE="${ENV_FILE:-/etc/default/uc-go-peer}"
READY_FILE="${READY_FILE:-/etc/default/uc-go-peer.ready}"
AUTOTLS_READY_FILE="${AUTOTLS_READY_FILE:-/etc/default/uc-go-peer.autotls-ready}"
AUTOTLS_ZONE_FILE="${AUTOTLS_ZONE_FILE:-/etc/default/uc-go-peer.autotls-zone}"
AUTOTLS_HOSTS_FILE="${AUTOTLS_HOSTS_FILE:-/etc/default/uc-go-peer.autotls-hosts}"
AUTOTLS_CADDY_READY_FILE="${AUTOTLS_CADDY_READY_FILE:-/etc/default/uc-go-peer.caddy-ready}"
APP_BINARY="${APP_BINARY:-/usr/local/bin/universal-chat-go}"
PHASE="${1:-all}"

if [ ! -d "${INSTALL_DIR}" ]; then
  echo "Missing ${INSTALL_DIR}; the rootfs build did not create the relay support directory."
  exit 1
fi

echo "[uc-go-peer-bootstrap] starting"
echo "[uc-go-peer-bootstrap] support dir: ${INSTALL_DIR}"
echo "[uc-go-peer-bootstrap] data dir: ${DATA_DIR}"
echo "[uc-go-peer-bootstrap] env file: ${ENV_FILE}"
echo "[uc-go-peer-bootstrap] app binary: ${APP_BINARY}"

run_phase_base() {
  export DEBIAN_FRONTEND=noninteractive
  echo "[uc-go-peer-bootstrap] phase=base"
  echo "[uc-go-peer-bootstrap] running apt-get update"
  apt-get update
  echo "[uc-go-peer-bootstrap] installing base packages"
  apt-get install -y ca-certificates curl caddy python3-pip
  python3 -m pip install --break-system-packages --no-cache-dir eth-account
  rm -rf /var/lib/apt/lists/*
}

run_phase_build() {
  echo "[uc-go-peer-bootstrap] phase=build"
  if [ ! -x "${APP_BINARY}" ]; then
    echo "[uc-go-peer-bootstrap] missing application binary: ${APP_BINARY}"
    exit 1
  fi
  echo "[uc-go-peer-bootstrap] application binary already provisioned"
}

run_phase_finalize() {
  echo "[uc-go-peer-bootstrap] phase=finalize"
  echo "[uc-go-peer-bootstrap] creating runtime directories"
  mkdir -p "${DATA_DIR}" "$(dirname "${ENV_FILE}")"

  if ! id "${SERVICE_USER}" >/dev/null 2>&1; then
    echo "[uc-go-peer-bootstrap] creating service user ${SERVICE_USER}"
    useradd --system --home "${DATA_DIR}" --create-home --shell /usr/sbin/nologin "${SERVICE_USER}"
  fi

  echo "[uc-go-peer-bootstrap] fixing ownership"
  chown -R "${SERVICE_USER}:${SERVICE_USER}" "${DATA_DIR}" "${INSTALL_DIR}"

  echo "[uc-go-peer-bootstrap] preparing environment file"
  touch "${ENV_FILE}"
  chmod 0640 "${ENV_FILE}"
  chown "root:${SERVICE_USER}" "${ENV_FILE}"
  rm -f "${READY_FILE}" "${AUTOTLS_READY_FILE}" "${AUTOTLS_ZONE_FILE}" "${AUTOTLS_HOSTS_FILE}" "${AUTOTLS_CADDY_READY_FILE}"

  mkdir -p /etc/caddy /etc/systemd/system/caddy.service.d
  cat > /etc/systemd/system/caddy.service.d/uc-go-peer.conf <<EOF
[Unit]
ConditionPathExists=${AUTOTLS_CADDY_READY_FILE}
EOF
}

write_env_var() {
  local key="$1"
  local value="$2"

  if grep -Eq "^[#[:space:]]*${key}=" "${ENV_FILE}"; then
    sed -i "s|^[#[:space:]]*${key}=.*|${key}=${value}|" "${ENV_FILE}"
  else
    printf '%s=%s\n' "${key}" "${value}" >> "${ENV_FILE}"
  fi
}

seed_env() {
  write_env_var "GO_PEER_DATA_DIR" "${DATA_DIR}"
  write_env_var "GO_PEER_TCP_PORT" "9095"
  write_env_var "GO_PEER_WS_PORT" "9096"
  write_env_var "GO_PEER_WSS_PORT" "9097"
  write_env_var "GO_PEER_IDENTITY_PATH" "${DATA_DIR}/identity.key"
  write_env_var "GO_PEER_WS_BACKEND_PORT" "9096"
  write_env_var "GO_PEER_AUTOTLS_CERT_DIR" "${DATA_DIR}/p2p-forge-certs"
  write_env_var "LIBP2P_AUTO_PUBLIC_IP" "0"
}

case "${PHASE}" in
  base)
    run_phase_base
    ;;
  build)
    run_phase_build
    ;;
  finalize)
    run_phase_finalize
    seed_env
    ;;
  all)
    run_phase_base
    run_phase_build
    run_phase_finalize
    seed_env
    ;;
  *)
    echo "Unknown phase: ${PHASE}" >&2
    exit 1
    ;;
esac

echo "[uc-go-peer-bootstrap] completed phase ${PHASE}"
