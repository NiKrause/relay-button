#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/orbitdb-relay-pinner}"
SERVICE_USER="${SERVICE_USER:-orbitdb-relay}"
DATA_DIR="${DATA_DIR:-/var/lib/orbitdb-relay-pinner}"
ENV_FILE="${ENV_FILE:-/etc/default/orbitdb-relay-pinner}"
NODE_MIN_MAJOR="${NODE_MIN_MAJOR:-22}"
CADDY_READY_FILE="${CADDY_READY_FILE:-/etc/default/orbitdb-relay-pinner.caddy-ready}"

if [ ! -d "${INSTALL_DIR}" ]; then
  echo "Missing ${INSTALL_DIR}; the rootfs build did not copy orbitdb-relay-pinner."
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl gnupg python3 python3-pip build-essential caddy

if ! command -v node >/dev/null 2>&1 || [ "$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)" -lt "${NODE_MIN_MAJOR}" ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

rm -rf /var/lib/apt/lists/*

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js ${NODE_MIN_MAJOR}+ installation failed." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is unavailable after installing Node.js." >&2
  exit 1
fi

python3 -m pip install --break-system-packages --no-cache-dir eth-account

mkdir -p "${DATA_DIR}" "$(dirname "${ENV_FILE}")"

if ! id "${SERVICE_USER}" >/dev/null 2>&1; then
  useradd --system --home "${DATA_DIR}" --create-home --shell /usr/sbin/nologin "${SERVICE_USER}"
fi

chown -R "${SERVICE_USER}:${SERVICE_USER}" "${DATA_DIR}" "${INSTALL_DIR}"

install_command="cd '${INSTALL_DIR}' && npm install --omit=dev"
if [ -f "${INSTALL_DIR}/pnpm-lock.yaml" ] && command -v corepack >/dev/null 2>&1; then
  package_manager="$(
    node -e "const fs=require('fs'); const pkg=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); process.stdout.write(pkg.packageManager || '')" \
      "${INSTALL_DIR}/package.json" 2>/dev/null || true
  )"
  if [ -n "${package_manager}" ]; then
    install_command="cd '${INSTALL_DIR}' && export COREPACK_HOME='${DATA_DIR}/.cache/corepack' && mkdir -p \"\$COREPACK_HOME\" && corepack prepare '${package_manager}' --activate && corepack pnpm install --prod --frozen-lockfile"
  fi
fi

if command -v runuser >/dev/null 2>&1; then
  runuser -u "${SERVICE_USER}" -- env HOME="${DATA_DIR}" bash -lc "${install_command}"
elif command -v sudo >/dev/null 2>&1; then
  sudo -u "${SERVICE_USER}" env HOME="${DATA_DIR}" bash -lc "${install_command}"
else
  echo "Need runuser or sudo to install dependencies as ${SERVICE_USER}." >&2
  exit 1
fi

# Drop toolchains and caches after dependency installation so the prebaked
# qcow2 reflects the runtime footprint rather than the build footprint.
apt-get purge -y build-essential
apt-get autoremove -y
apt-get clean
rm -rf /var/lib/apt/lists/*
rm -rf "${DATA_DIR}/.cache/corepack" "${DATA_DIR}/.npm" "${DATA_DIR}/.cache/npm"
rm -rf "${INSTALL_DIR}/node_modules/.cache"

mkdir -p "${INSTALL_DIR}/node_modules"
ln -sfn "${INSTALL_DIR}" "${INSTALL_DIR}/node_modules/orbitdb-relay-pinner"

cat > /usr/local/bin/orbitdb-relay-pinner <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exec /usr/bin/node /opt/orbitdb-relay-pinner/dist/cli.js "$@"
EOF
chmod 0755 /usr/local/bin/orbitdb-relay-pinner

if [ -f "${INSTALL_DIR}/deploy/orbitdb-relay-pinner.env.example" ] && [ ! -f "${ENV_FILE}" ]; then
  cp "${INSTALL_DIR}/deploy/orbitdb-relay-pinner.env.example" "${ENV_FILE}"
fi

touch "${ENV_FILE}"
chmod 0640 "${ENV_FILE}"
chown "root:${SERVICE_USER}" "${ENV_FILE}"
rm -f "${CADDY_READY_FILE}"

mkdir -p /etc/caddy /etc/systemd/system/caddy.service.d
cat > /etc/systemd/system/caddy.service.d/orbitdb-relay-pinner.conf <<EOF
[Unit]
ConditionPathExists=${CADDY_READY_FILE}
EOF

write_env_var() {
  local key="$1"
  local value="$2"

  if grep -Eq "^[#[:space:]]*${key}=" "${ENV_FILE}"; then
    sed -i "s|^[#[:space:]]*${key}=.*|${key}=${value}|" "${ENV_FILE}"
  else
    printf '%s=%s\n' "${key}" "${value}" >> "${ENV_FILE}"
  fi
}

write_env_var "DATASTORE_PATH" "${DATA_DIR}"
write_env_var "METRICS_PORT" "9090"
write_env_var "METRICS_HTTPS_ENABLED" "0"
write_env_var "RELAY_TCP_PORT" "9091"
write_env_var "RELAY_WS_PORT" "9092"
write_env_var "RELAY_WEBRTC_PORT" "9093"
write_env_var "RELAY_QUIC_PORT" "9094"
write_env_var "RELAY_DISABLE_WEBRTC" "1"
write_env_var "RELAY_DISABLE_BOOTSTRAP" "1"
write_env_var "disableAutoTLS" "1"
write_env_var "ENABLE_GENERAL_LOGS" "1"
write_env_var "DEBUG" "'libp2p:websockets:listener'"
