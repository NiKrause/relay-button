#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${ENV_FILE:-/etc/default/ucan-store}"
APP_BINARY="${APP_BINARY:-/usr/local/bin/ucan-store}"
BOOTSTRAP_VALIDATOR="${BOOTSTRAP_VALIDATOR:-/usr/local/sbin/ucan_store_bootstrap_validate.py}"
BOOTSTRAP_PACKAGE_FILE_DEFAULT="${BOOTSTRAP_PACKAGE_FILE:-/etc/ucan-store/bootstrap-package.json}"
VERIFY_TIMEOUT_DEFAULT="${BOOTSTRAP_VERIFICATION_TIMEOUT_SECONDS:-60}"
VERIFY_INTERVAL_DEFAULT="${BOOTSTRAP_VERIFICATION_INTERVAL_SECONDS:-2}"
APP_PID=""

if [ -f "${ENV_FILE}" ]; then
  set -a
  # shellcheck disable=SC1090
  . "${ENV_FILE}"
  set +a
fi

SERVICE_PORT="${STORACHA_LOCAL_PORT:-8787}"
BOOTSTRAP_PACKAGE_FILE="${UCAN_STORE_BOOTSTRAP_PACKAGE_FILE:-${BOOTSTRAP_PACKAGE_FILE_DEFAULT}}"
PUBLIC_UPLOAD_SERVICE_URL="${PUBLIC_UPLOAD_SERVICE_URL:-}"
ADMIN_DID="${UCAN_STORE_ADMIN_DID:-}"
VERIFY_TIMEOUT_SECONDS="${BOOTSTRAP_VERIFICATION_TIMEOUT_SECONDS:-${VERIFY_TIMEOUT_DEFAULT}}"
VERIFY_INTERVAL_SECONDS="${BOOTSTRAP_VERIFICATION_INTERVAL_SECONDS:-${VERIFY_INTERVAL_DEFAULT}}"
REQUIRE_BOOTSTRAP_PACKAGE="${UCAN_STORE_REQUIRE_BOOTSTRAP_PACKAGE:-1}"
BOOTSTRAP_VALIDATION_MODE="enforce"

is_truthy() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

terminate_child() {
  if [ -n "${APP_PID}" ] && kill -0 "${APP_PID}" 2>/dev/null; then
    kill "${APP_PID}" 2>/dev/null || true
    wait "${APP_PID}" 2>/dev/null || true
  fi
}

validate_bootstrap_preflight() {
  if [ ! -f "${BOOTSTRAP_PACKAGE_FILE}" ]; then
    if is_truthy "${REQUIRE_BOOTSTRAP_PACKAGE}"; then
      echo "Missing required bootstrap package: ${BOOTSTRAP_PACKAGE_FILE}" >&2
      exit 1
    fi
    BOOTSTRAP_VALIDATION_MODE="skip"
    echo "Bootstrap package not configured; skipping startup validation." >&2
    return 0
  fi

  if ! python3 "${BOOTSTRAP_VALIDATOR}" \
    --package-file "${BOOTSTRAP_PACKAGE_FILE}" \
    --runtime-service-origin "${PUBLIC_UPLOAD_SERVICE_URL}" \
    --admin-did "${ADMIN_DID}" >/dev/null; then
    echo "Bootstrap package preflight validation failed." >&2
    exit 1
  fi
}

probe_service_did() {
  python3 - "${SERVICE_PORT}" "${VERIFY_TIMEOUT_SECONDS}" "${VERIFY_INTERVAL_SECONDS}" <<'PY'
import json
import sys
import time
import urllib.error
import urllib.request

port = int(sys.argv[1])
timeout_seconds = float(sys.argv[2])
interval_seconds = float(sys.argv[3])
url = f"http://127.0.0.1:{port}/.well-known/did.json"
deadline = time.monotonic() + timeout_seconds
last_error = None

while time.monotonic() < deadline:
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
    time.sleep(interval_seconds)

raise SystemExit(last_error or "service DID probe timed out")
PY
}

trap terminate_child EXIT INT TERM
validate_bootstrap_preflight

"${APP_BINARY}" "$@" &
APP_PID="$!"

if [ "${BOOTSTRAP_VALIDATION_MODE}" = "enforce" ]; then
  SERVICE_DID="$(probe_service_did)"
  python3 "${BOOTSTRAP_VALIDATOR}" \
    --package-file "${BOOTSTRAP_PACKAGE_FILE}" \
    --runtime-service-did "${SERVICE_DID}" \
    --runtime-service-origin "${PUBLIC_UPLOAD_SERVICE_URL}" \
    --admin-did "${ADMIN_DID}" >/dev/null
fi

wait "${APP_PID}"
