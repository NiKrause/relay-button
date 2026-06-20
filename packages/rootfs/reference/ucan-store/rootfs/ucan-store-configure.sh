#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${ENV_FILE:-/etc/default/ucan-store}"
READY_FILE="${READY_FILE:-/etc/default/ucan-store.ready}"
BOOTSTRAP_PACKAGE_FILE="${BOOTSTRAP_PACKAGE_FILE:-/etc/ucan-store/bootstrap-package.json}"
BOOTSTRAP_VALIDATOR="${BOOTSTRAP_VALIDATOR:-/usr/local/sbin/ucan_store_bootstrap_validate.py}"
BOOTSTRAP_CRYPTO_VERIFIER="${BOOTSTRAP_CRYPTO_VERIFIER:-/usr/local/sbin/ucan-store-bootstrap-verify.mjs}"
BOOTSTRAP_VERIFICATION_FILE="${BOOTSTRAP_VERIFICATION_FILE:-/etc/ucan-store/bootstrap-verification.json}"
SERVICE_NAME="${SERVICE_NAME:-ucan-store.service}"
CADDY_SERVICE="${CADDY_SERVICE:-caddy.service}"
CADDYFILE="${CADDYFILE:-/etc/caddy/Caddyfile}"
SERVICE_PORT="${SERVICE_PORT:-8787}"
PROXY_PORT="${PROXY_PORT:-8788}"
SERVICE_GROUP="${SERVICE_GROUP:-ucan-store}"
PUBLIC_IPV4=""
PUBLIC_IPV6=""
PROXY_HOSTNAME=""
SERVICE_HOSTNAME=""
SERVICE_DID=""
SERVICE_ORIGIN=""
WEBAUTHN_ORIGIN=""
WEBAUTHN_ORIGIN_FALLBACKS=""
ADMIN_DID=""
ADMIN_API_TOKEN=""
BOOTSTRAP_PACKAGE_INPUT_FILE=""
START_SERVICE=1

usage() {
  cat <<'EOF'
Usage:
  ucan-store-configure.sh \
    --public-ipv4 <ip> \
    [--public-ipv6 <ipv6>] \
    [--proxy-hostname <hostname>] \
    [--service-did <did>] \
    [--service-origin <origin>] \
    [--webauthn-origin <origin>] \
    [--webauthn-origin-fallbacks <csv>] \
    [--admin-did <did>] \
    [--admin-api-token <token>] \
    [--bootstrap-package-file <path>] \
    [--no-start]

Writes the public service wiring for the current ucan-store deployment,
enables the guest service, and stores the resulting PWA-facing `VITE_*` values.
EOF
}

write_env_var() {
  local key="$1"
  local value="$2"

  python3 - "${ENV_FILE}" "${key}" "${value}" <<'PY'
import re
import sys
from pathlib import Path

env_file, key, value = sys.argv[1:4]
target = Path(env_file)
pattern = re.compile(rf"^[#\s]*{re.escape(key)}=.*$", re.MULTILINE)

raw = target.read_text(encoding="utf-8") if target.exists() else ""
replacement = f"{key}={value}"

if pattern.search(raw):
    updated = pattern.sub(replacement, raw, count=1)
else:
    updated = raw + ("" if raw.endswith("\n") or not raw else "\n") + replacement + "\n"

target.write_text(updated, encoding="utf-8")
PY
}

write_caddyfile() {
  local hostnames=()
  local hostname
  local known
  for hostname in "$@"; do
    if [ -z "${hostname}" ]; then
      continue
    fi
    known="0"
    if [ "${#hostnames[@]}" -gt 0 ]; then
      for existing in "${hostnames[@]}"; do
        if [ "${existing}" = "${hostname}" ]; then
          known="1"
          break
        fi
      done
    fi
    if [ "${known}" = "0" ]; then
      hostnames+=("${hostname}")
    fi
  done

  if [ "${#hostnames[@]}" -eq 0 ]; then
    return 0
  fi

  local site_label
  local index
  site_label="${hostnames[0]}"
  for ((index = 1; index < ${#hostnames[@]}; index++)); do
    site_label+=", ${hostnames[${index}]}"
  done
  mkdir -p "$(dirname "${CADDYFILE}")"
  cat > "${CADDYFILE}" <<EOF
{
  auto_https disable_redirects
}

${site_label} {
  reverse_proxy 127.0.0.1:${PROXY_PORT}
}
EOF
}

derive_hostname_from_origin() {
  python3 - "${1:-}" <<'PY'
import sys
from urllib.parse import urlsplit

raw = (sys.argv[1] or "").strip()
if not raw:
    raise SystemExit(0)

parsed = urlsplit(raw)
host = (parsed.hostname or "").strip().lower()
if not host:
    raise SystemExit(0)

print(host)
PY
}

derive_service_did_from_hostname() {
  python3 - "${1:-}" <<'PY'
import sys
from urllib.parse import urlsplit

raw = (sys.argv[1] or "").strip()
if not raw:
    raise SystemExit(0)

parsed = urlsplit(raw if "://" in raw else f"https://{raw}")
host = (parsed.hostname or "").strip().lower()
if not host:
    raise SystemExit(0)

port = f"%3A{parsed.port}" if parsed.port else ""
print(f"did:web:{host}{port}")
PY
}

probe_service_did() {
  python3 - "${SERVICE_PORT}" <<'PY'
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

install_bootstrap_package() {
  local source_file="$1"
  mkdir -p "$(dirname "${BOOTSTRAP_PACKAGE_FILE}")"
  python3 "${BOOTSTRAP_VALIDATOR}" --package-file "${source_file}" >/dev/null
  node "${BOOTSTRAP_CRYPTO_VERIFIER}" \
    --package-file "${source_file}" \
    --admin-did "${ADMIN_DID}" \
    --summary-file "${BOOTSTRAP_VERIFICATION_FILE}" >/dev/null
  cp "${source_file}" "${BOOTSTRAP_PACKAGE_FILE}"
  if chgrp "${SERVICE_GROUP}" "${BOOTSTRAP_PACKAGE_FILE}" 2>/dev/null; then
    chmod 0640 "${BOOTSTRAP_PACKAGE_FILE}"
  else
    chmod 0644 "${BOOTSTRAP_PACKAGE_FILE}"
  fi
  install_bootstrap_verification_permissions
}

install_bootstrap_verification_permissions() {
  if chgrp "${SERVICE_GROUP}" "${BOOTSTRAP_VERIFICATION_FILE}" 2>/dev/null; then
    chmod 0664 "${BOOTSTRAP_VERIFICATION_FILE}"
  else
    chmod 0666 "${BOOTSTRAP_VERIFICATION_FILE}"
  fi
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
    --service-did)
      SERVICE_DID="${2:-}"
      shift 2
      ;;
    --service-origin)
      SERVICE_ORIGIN="${2:-}"
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
    --admin-api-token)
      ADMIN_API_TOKEN="${2:-}"
      shift 2
      ;;
    --bootstrap-package-file)
      BOOTSTRAP_PACKAGE_INPUT_FILE="${2:-}"
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
SERVICE_ORIGIN="${SERVICE_ORIGIN%/}"

touch "${ENV_FILE}"

write_env_var "PUBLIC_IPV4" "${PUBLIC_IPV4}"
write_env_var "PUBLIC_IPV6" "${PUBLIC_IPV6}"
write_env_var "PROXY_HOSTNAME" "${PROXY_HOSTNAME}"
write_env_var "UCAN_STORE_SERVICE_KEY_ALGORITHM" "${UCAN_STORE_SERVICE_KEY_ALGORITHM:-ed25519}"
write_env_var "UCAN_STORE_ADMIN_DID" "${ADMIN_DID}"
write_env_var "UCAN_STORE_ADMIN_API_TOKEN" "${ADMIN_API_TOKEN}"
write_env_var "UCAN_STORE_BOOTSTRAP_PACKAGE_FILE" "${BOOTSTRAP_PACKAGE_FILE}"
write_env_var "UCAN_STORE_BOOTSTRAP_VERIFICATION_FILE" "${BOOTSTRAP_VERIFICATION_FILE}"

if [ -n "${BOOTSTRAP_PACKAGE_INPUT_FILE}" ]; then
  install_bootstrap_package "${BOOTSTRAP_PACKAGE_INPUT_FILE}"
fi

if [ -n "${WEBAUTHN_ORIGIN}" ]; then
  write_env_var "WEBAUTHN_ORIGIN" "${WEBAUTHN_ORIGIN}"
fi
write_env_var "WEBAUTHN_ORIGIN_FALLBACKS" "${WEBAUTHN_ORIGIN_FALLBACKS}"

if [ -z "${SERVICE_DID}" ] && [ -n "${PROXY_HOSTNAME}" ]; then
  SERVICE_DID="$(derive_service_did_from_hostname "${PROXY_HOSTNAME}")"
fi

if [ -z "${SERVICE_ORIGIN}" ] && [ -n "${PROXY_HOSTNAME}" ]; then
  SERVICE_ORIGIN="https://${PROXY_HOSTNAME}"
fi
SERVICE_HOSTNAME="$(derive_hostname_from_origin "${SERVICE_ORIGIN}")"

write_env_var "UCAN_STORE_SERVICE_DID" "${SERVICE_DID}"
write_env_var "UCAN_STORE_SERVICE_HOSTNAME" "${SERVICE_HOSTNAME}"

if [ -n "${SERVICE_ORIGIN}" ]; then
  write_env_var "PUBLIC_UPLOAD_SERVICE_URL" "${SERVICE_ORIGIN}"
  write_env_var "PUBLIC_REVOCATION_URL" "${SERVICE_ORIGIN}"
  write_env_var "PUBLIC_RECEIPTS_URL" "${SERVICE_ORIGIN}/receipt/"
fi

if [ -n "${PROXY_HOSTNAME}" ]; then
  write_caddyfile "${PROXY_HOSTNAME}" "${SERVICE_HOSTNAME}"
fi

touch "${READY_FILE}"

if [ "${START_SERVICE}" = "1" ]; then
  systemctl daemon-reload
  systemctl restart "${SERVICE_NAME}"
  if [ -n "${PROXY_HOSTNAME}" ]; then
    systemctl restart "${CADDY_SERVICE}"
  fi

  PROBED_SERVICE_DID="$(probe_service_did)"
  if [ -z "${SERVICE_DID}" ]; then
    SERVICE_DID="${PROBED_SERVICE_DID}"
    write_env_var "UCAN_STORE_SERVICE_DID" "${SERVICE_DID}"
  fi
  write_env_var "PUBLIC_UPLOAD_SERVICE_DID" "${SERVICE_DID}"
  write_env_var "PUBLIC_REVOCATION_DID" "${SERVICE_DID}"

  if [ -f "${BOOTSTRAP_PACKAGE_FILE}" ]; then
    python3 "${BOOTSTRAP_VALIDATOR}" \
      --package-file "${BOOTSTRAP_PACKAGE_FILE}" \
      --runtime-service-did "${SERVICE_DID}" \
      --runtime-service-origin "${SERVICE_ORIGIN}" \
      --admin-did "${ADMIN_DID}" >/dev/null
    node "${BOOTSTRAP_CRYPTO_VERIFIER}" \
      --package-file "${BOOTSTRAP_PACKAGE_FILE}" \
      --runtime-service-did "${SERVICE_DID}" \
      --runtime-service-origin "${SERVICE_ORIGIN}" \
      --admin-did "${ADMIN_DID}" \
      --summary-file "${BOOTSTRAP_VERIFICATION_FILE}" >/dev/null
    install_bootstrap_verification_permissions
  fi
fi
