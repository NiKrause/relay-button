#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/ucan-store}"
SERVICE_USER="${SERVICE_USER:-ucan-store}"
DATA_DIR="${DATA_DIR:-/var/lib/ucan-store}"
ENV_FILE="${ENV_FILE:-/etc/default/ucan-store}"
READY_FILE="${READY_FILE:-/etc/default/ucan-store.ready}"
APP_BINARY="${APP_BINARY:-/usr/local/bin/ucan-store}"
NODE_MIN_MAJOR="${NODE_MIN_MAJOR:-22}"
PHASE="${1:-all}"

if [ ! -d "${INSTALL_DIR}" ]; then
  echo "Missing ${INSTALL_DIR}; the rootfs build did not copy ucan-store." >&2
  exit 1
fi

write_env_var() {
  local key="$1"
  local value="$2"

  if grep -Eq "^[#[:space:]]*${key}=" "${ENV_FILE}"; then
    sed -i "s|^[#[:space:]]*${key}=.*|${key}=${value}|" "${ENV_FILE}"
  else
    printf '%s=%s\n' "${key}" "${value}" >> "${ENV_FILE}"
  fi
}

run_phase_base() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y ca-certificates curl gnupg caddy python3

  if ! command -v node >/dev/null 2>&1 || [ "$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)" -lt "${NODE_MIN_MAJOR}" ]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  fi

  rm -rf /var/lib/apt/lists/*
}

run_phase_build() {
  if [ ! -f "${INSTALL_DIR}/web/package.json" ]; then
    echo "Missing ${INSTALL_DIR}/web/package.json" >&2
    exit 1
  fi
  if [ ! -f "${INSTALL_DIR}/web/package-lock.json" ]; then
    echo "Missing ${INSTALL_DIR}/web/package-lock.json" >&2
    exit 1
  fi

  mkdir -p "${DATA_DIR}" "$(dirname "${ENV_FILE}")"
  if ! id "${SERVICE_USER}" >/dev/null 2>&1; then
    useradd --system --home "${DATA_DIR}" --create-home --shell /usr/sbin/nologin "${SERVICE_USER}"
  fi

  chown -R "${SERVICE_USER}:${SERVICE_USER}" "${DATA_DIR}" "${INSTALL_DIR}"

  if command -v runuser >/dev/null 2>&1; then
    runuser -u "${SERVICE_USER}" -- env HOME="${DATA_DIR}" bash -lc "cd '${INSTALL_DIR}/web' && npm ci"
  else
    echo "runuser is required to install npm dependencies as ${SERVICE_USER}" >&2
    exit 1
  fi

  rm -rf "${DATA_DIR}/.npm" "${INSTALL_DIR}/web/node_modules/.cache"
}

run_phase_finalize() {
  mkdir -p "${DATA_DIR}" "$(dirname "${ENV_FILE}")" /etc/caddy
  chown -R "${SERVICE_USER}:${SERVICE_USER}" "${DATA_DIR}" "${INSTALL_DIR}"

  cat > "${APP_BINARY}" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exec /usr/bin/node /opt/ucan-store/local-storacha-api/index.mjs "$@"
EOF
  chmod 0755 "${APP_BINARY}"

  touch "${ENV_FILE}"
  chmod 0640 "${ENV_FILE}"
  chown "root:${SERVICE_USER}" "${ENV_FILE}"
  rm -f "${READY_FILE}"

  write_env_var "NODE_ENV" "production"
  write_env_var "STORACHA_LOCAL_PORT" "8787"
  write_env_var "WEBAUTHN_ORIGIN" "http://localhost:5173"
  write_env_var "WEBAUTHN_ORIGIN_FALLBACKS" ""
  write_env_var "UCAN_STORE_ADMIN_DID" ""
  write_env_var "PUBLIC_IPV4" ""
  write_env_var "PUBLIC_IPV6" ""
  write_env_var "PROXY_HOSTNAME" ""
  write_env_var "PUBLIC_UPLOAD_SERVICE_URL" ""
  write_env_var "PUBLIC_UPLOAD_SERVICE_DID" ""
  write_env_var "PUBLIC_REVOCATION_URL" ""
  write_env_var "PUBLIC_REVOCATION_DID" ""
  write_env_var "PUBLIC_RECEIPTS_URL" ""
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
    ;;
  all)
    run_phase_base
    run_phase_build
    run_phase_finalize
    ;;
  *)
    echo "Unknown phase: ${PHASE}" >&2
    exit 1
    ;;
esac
