#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${ENV_FILE:-/etc/default/ucan-store}"
READY_FILE="${READY_FILE:-/etc/default/ucan-store.ready}"
SERVICE_NAME="${SERVICE_NAME:-ucan-store.service}"
CADDY_SERVICE="${CADDY_SERVICE:-caddy.service}"
CADDYFILE="${CADDYFILE:-/etc/caddy/Caddyfile}"
UPSTREAM_PORT="${UPSTREAM_PORT:-8787}"
PUBLIC_IPV4=""
PUBLIC_IPV6=""
PROXY_HOSTNAME=""
WEBAUTHN_ORIGIN=""
WEBAUTHN_ORIGIN_FALLBACKS=""
ADMIN_DID=""
START_SERVICE=1

usage() {
  cat <<'EOF'
Usage:
  ucan-store-configure.sh \
    --public-ipv4 <ip> \
    [--public-ipv6 <ipv6>] \
    [--proxy-hostname <hostname>] \
    [--webauthn-origin <origin>] \
    [--webauthn-origin-fallbacks <csv>] \
    [--admin-did <did>] \
    [--no-start]

Writes the public service wiring for the current ucan-store deployment,
enables the guest service, and stores the resulting PWA-facing `VITE_*` values.
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

write_caddyfile() {
  local hostname="$1"
  mkdir -p "$(dirname "${CADDYFILE}")"
  cat > "${CADDYFILE}" <<EOF
{
  auto_https disable_redirects
}

${hostname} {
  reverse_proxy 127.0.0.1:${UPSTREAM_PORT}
}
EOF
}

probe_service_did() {
  python3 - "${UPSTREAM_PORT}" <<'PY'
import json
import sys
import time
import urllib.error
import urllib.request

port = int(sys.argv[1])
url = f"http://127.0.0.1:{port}/.well-known/did.json"
deadline = time.time() + 60
last_error = None

while time.time() < deadline:
    try:
        with urllib.request.urlopen(url, timeout=5) as response:
            payload = json.loads(response.read().decode("utf-8"))
        did = payload.get("id")
        if isinstance(did, str) and did.strip():
            print(did.strip())
            raise SystemExit(0)
        last_error = "did.json missing id"
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
        last_error = str(error)
    time.sleep(2)

raise SystemExit(last_error or "service DID probe timed out")
PY
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --public-ipv4)
      PUBLIC_IPV4="${2:-}"
      shift 2
      ;;
    --public-ipv6)
      PUBLIC_IPV6="${2:-}"
      shift 2
      ;;
    --proxy-hostname)
      PROXY_HOSTNAME="${2:-}"
      shift 2
      ;;
    --webauthn-origin)
      WEBAUTHN_ORIGIN="${2:-}"
      shift 2
      ;;
    --webauthn-origin-fallbacks)
      WEBAUTHN_ORIGIN_FALLBACKS="${2:-}"
      shift 2
      ;;
    --admin-did)
      ADMIN_DID="${2:-}"
      shift 2
      ;;
    --no-start)
      START_SERVICE=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [ -z "${PUBLIC_IPV4}" ]; then
  usage >&2
  exit 1
fi

touch "${ENV_FILE}"

write_env_var "PUBLIC_IPV4" "${PUBLIC_IPV4}"
write_env_var "PUBLIC_IPV6" "${PUBLIC_IPV6}"
write_env_var "PROXY_HOSTNAME" "${PROXY_HOSTNAME}"
write_env_var "UCAN_STORE_ADMIN_DID" "${ADMIN_DID}"

if [ -n "${WEBAUTHN_ORIGIN}" ]; then
  write_env_var "WEBAUTHN_ORIGIN" "${WEBAUTHN_ORIGIN}"
fi
write_env_var "WEBAUTHN_ORIGIN_FALLBACKS" "${WEBAUTHN_ORIGIN_FALLBACKS}"

if [ -n "${PROXY_HOSTNAME}" ]; then
  write_caddyfile "${PROXY_HOSTNAME}"
  write_env_var "PUBLIC_UPLOAD_SERVICE_URL" "https://${PROXY_HOSTNAME}"
  write_env_var "PUBLIC_REVOCATION_URL" "https://${PROXY_HOSTNAME}"
  write_env_var "PUBLIC_RECEIPTS_URL" "https://${PROXY_HOSTNAME}/receipt/"
fi

touch "${READY_FILE}"

if [ "${START_SERVICE}" = "1" ]; then
  systemctl daemon-reload
  systemctl restart "${SERVICE_NAME}"
  if [ -n "${PROXY_HOSTNAME}" ]; then
    systemctl restart "${CADDY_SERVICE}"
  fi

  SERVICE_DID="$(probe_service_did)"
  write_env_var "PUBLIC_UPLOAD_SERVICE_DID" "${SERVICE_DID}"
  write_env_var "PUBLIC_REVOCATION_DID" "${SERVICE_DID}"
fi
