#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${ENV_FILE:-/etc/default/orbitdb-relay-pinner}"
READY_FILE="${READY_FILE:-/etc/default/orbitdb-relay-pinner.ready}"
AUTOTLS_READY_FILE="${AUTOTLS_READY_FILE:-/etc/default/orbitdb-relay-pinner.autotls-ready}"
AUTOTLS_ZONE_FILE="${AUTOTLS_ZONE_FILE:-/etc/default/orbitdb-relay-pinner.autotls-zone}"
AUTOTLS_HOSTS_FILE="${AUTOTLS_HOSTS_FILE:-/etc/default/orbitdb-relay-pinner.autotls-hosts}"
SERVICE_NAME="${SERVICE_NAME:-orbitdb-relay-pinner.service}"
CADDY_SERVICE="${CADDY_SERVICE:-caddy.service}"
CADDY_READY_FILE="${CADDY_READY_FILE:-/etc/default/orbitdb-relay-pinner.caddy-ready}"
CADDYFILE="${CADDYFILE:-/etc/caddy/Caddyfile}"
CADDY_UPSTREAM_WSS_PORT="${CADDY_UPSTREAM_WSS_PORT:-9092}"
CADDY_UPSTREAM_HOST="${CADDY_UPSTREAM_HOST:-127.0.0.1}"
CADDY_UPSTREAM_METRICS_PORT="${CADDY_UPSTREAM_METRICS_PORT:-9090}"
AUTOTLS_REFRESH_SERVICE="${AUTOTLS_REFRESH_SERVICE:-orbitdb-relay-pinner-autotls-refresh.service}"
BOOTSTRAP_REFRESH_TIMER="${BOOTSTRAP_REFRESH_TIMER:-orbitdb-relay-pinner-bootstrap-refresh.timer}"
PUBLIC_IPV4=""
PUBLIC_IPV6=""
TCP_PORT=""
WS_PORT=""
PROXY_HOSTNAME=""
METRICS_PORT=""
METRICS_HTTPS_PORT=""
WEBRTC_PORT=""
QUIC_PORT=""
BOOTSTRAP_PUBLISHER_PRIVATE_KEY=""
BOOTSTRAP_PUBLISHER_LIBP2P_IDENTITY_HEX=""
BOOTSTRAP_OWNER_PRIVATE_KEY=""
BOOTSTRAP_OWNER_AUTHORIZATION_B64=""
BOOTSTRAP_REGISTRATION_ID=""
START_SERVICE=1

usage() {
  cat <<'EOF'
Usage:
  orbitdb-relay-pinner-configure.sh \
    --public-ipv4 <ip> \
    [--public-ipv6 <ipv6>] \
    --tcp-port <host-port> \
    --ws-port <host-port> \
    [--proxy-hostname <hostname>] \
    [--metrics-port <host-port>] \
    [--metrics-https-port <host-port>] \
    [--webrtc-port <host-port>] \
    [--quic-port <host-port>] \
    [--bootstrap-publisher-private-key <hex>] \
    [--bootstrap-publisher-libp2p-identity-hex <hex>] \
    [--bootstrap-owner-private-key <hex>] \
    [--bootstrap-owner-authorization-b64 <base64>] \
    [--bootstrap-registration-id <id>] \
    [--no-start]

Writes VITE_APPEND_ANNOUNCE for the externally assigned Aleph host ports,
marks the relay as ready, and optionally starts the relay plus Caddy services.
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
  # Proxy the full orbitdb-relay-pinner HTTP API surface to the metrics/HTTP port.
  # Everything else falls through to the relay WebSocket backend for browser libp2p.
  handle /health {
    reverse_proxy 127.0.0.1:${CADDY_UPSTREAM_METRICS_PORT}
  }

  handle /multiaddrs {
    reverse_proxy 127.0.0.1:${CADDY_UPSTREAM_METRICS_PORT}
  }

  handle /multiaddresses {
    reverse_proxy 127.0.0.1:${CADDY_UPSTREAM_METRICS_PORT}
  }

  handle /metrics {
    reverse_proxy 127.0.0.1:${CADDY_UPSTREAM_METRICS_PORT}
  }

  handle /pinning/* {
    reverse_proxy 127.0.0.1:${CADDY_UPSTREAM_METRICS_PORT}
  }

  handle /ipfs/* {
    reverse_proxy 127.0.0.1:${CADDY_UPSTREAM_METRICS_PORT}
  }

  reverse_proxy ${CADDY_UPSTREAM_HOST}:${CADDY_UPSTREAM_WSS_PORT}
}
EOF
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
    --tcp-port)
      TCP_PORT="${2:-}"
      shift 2
      ;;
    --ws-port)
      WS_PORT="${2:-}"
      shift 2
      ;;
    --proxy-hostname)
      PROXY_HOSTNAME="${2:-}"
      shift 2
      ;;
    --metrics-port)
      METRICS_PORT="${2:-}"
      shift 2
      ;;
    --metrics-https-port)
      METRICS_HTTPS_PORT="${2:-}"
      shift 2
      ;;
    --webrtc-port)
      WEBRTC_PORT="${2:-}"
      shift 2
      ;;
    --quic-port)
      QUIC_PORT="${2:-}"
      shift 2
      ;;
    --bootstrap-publisher-private-key)
      BOOTSTRAP_PUBLISHER_PRIVATE_KEY="${2:-}"
      shift 2
      ;;
    --bootstrap-publisher-libp2p-identity-hex)
      BOOTSTRAP_PUBLISHER_LIBP2P_IDENTITY_HEX="${2:-}"
      shift 2
      ;;
    --bootstrap-owner-private-key)
      BOOTSTRAP_OWNER_PRIVATE_KEY="${2:-}"
      shift 2
      ;;
    --bootstrap-owner-authorization-b64)
      BOOTSTRAP_OWNER_AUTHORIZATION_B64="${2:-}"
      shift 2
      ;;
    --bootstrap-registration-id)
      BOOTSTRAP_REGISTRATION_ID="${2:-}"
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

if [ -z "${PUBLIC_IPV4}" ] || [ -z "${TCP_PORT}" ] || [ -z "${WS_PORT}" ]; then
  usage >&2
  exit 1
fi

touch "${ENV_FILE}"
rm -f "${AUTOTLS_READY_FILE}" "${AUTOTLS_ZONE_FILE}" "${AUTOTLS_HOSTS_FILE}"

announce=(
  "/ip4/${PUBLIC_IPV4}/tcp/${TCP_PORT}"
)

if [ -n "${PUBLIC_IPV6}" ]; then
  announce+=(
    "/ip6/${PUBLIC_IPV6}/tcp/${TCP_PORT}"
  )
fi

if [ -n "${PROXY_HOSTNAME}" ]; then
  announce+=("/dns4/${PROXY_HOSTNAME}/tcp/443/tls/ws")
  announce+=("/dns6/${PROXY_HOSTNAME}/tcp/443/tls/ws")
else
  announce+=("/ip4/${PUBLIC_IPV4}/tcp/${WS_PORT}/ws")
  if [ -n "${PUBLIC_IPV6}" ]; then
    announce+=("/ip6/${PUBLIC_IPV6}/tcp/${WS_PORT}/ws")
  fi
fi

if [ -n "${WEBRTC_PORT}" ]; then
  announce+=("/ip4/${PUBLIC_IPV4}/udp/${WEBRTC_PORT}/webrtc-direct")
  if [ -n "${PUBLIC_IPV6}" ]; then
    announce+=("/ip6/${PUBLIC_IPV6}/udp/${WEBRTC_PORT}/webrtc-direct")
  fi
fi

if [ -n "${QUIC_PORT}" ]; then
  announce+=("/ip4/${PUBLIC_IPV4}/udp/${QUIC_PORT}/quic-v1")
  if [ -n "${PUBLIC_IPV6}" ]; then
    announce+=("/ip6/${PUBLIC_IPV6}/udp/${QUIC_PORT}/quic-v1")
  fi
fi

announce_value="$(IFS=,; printf '%s' "${announce[*]}")"
write_env_var "VITE_APPEND_ANNOUNCE" "${announce_value}"
write_env_var "PUBLIC_IPV4" "${PUBLIC_IPV4}"
if [ -n "${PUBLIC_IPV6}" ]; then
  write_env_var "PUBLIC_IPV6" "${PUBLIC_IPV6}"
fi
write_env_var "EXTERNAL_RELAY_TCP_PORT" "${TCP_PORT}"
write_env_var "EXTERNAL_RELAY_WS_PORT" "${WS_PORT}"
if [ -n "${PROXY_HOSTNAME}" ]; then
  write_env_var "PROXY_HOSTNAME" "${PROXY_HOSTNAME}"
else
  write_env_var "PROXY_HOSTNAME" ""
fi
if [ -n "${METRICS_PORT}" ]; then
  write_env_var "EXTERNAL_METRICS_PORT" "${METRICS_PORT}"
fi
if [ -n "${METRICS_HTTPS_PORT}" ]; then
  write_env_var "EXTERNAL_METRICS_HTTPS_PORT" "${METRICS_HTTPS_PORT}"
fi
if [ -n "${WEBRTC_PORT}" ]; then
  write_env_var "EXTERNAL_RELAY_WEBRTC_PORT" "${WEBRTC_PORT}"
fi
if [ -n "${QUIC_PORT}" ]; then
  write_env_var "EXTERNAL_RELAY_QUIC_PORT" "${QUIC_PORT}"
fi
if [ -n "${BOOTSTRAP_PUBLISHER_PRIVATE_KEY}" ]; then
  write_env_var "ALEPH_BOOTSTRAP_PUBLISHER_PRIVATE_KEY" "${BOOTSTRAP_PUBLISHER_PRIVATE_KEY}"
fi
if [ -n "${BOOTSTRAP_PUBLISHER_LIBP2P_IDENTITY_HEX}" ]; then
  write_env_var "RELAY_PRIV_KEY" "${BOOTSTRAP_PUBLISHER_LIBP2P_IDENTITY_HEX}"
fi
if [ -n "${BOOTSTRAP_OWNER_PRIVATE_KEY}" ]; then
  write_env_var "ALEPH_BOOTSTRAP_OWNER_PRIVATE_KEY" "${BOOTSTRAP_OWNER_PRIVATE_KEY}"
fi
if [ -n "${BOOTSTRAP_OWNER_AUTHORIZATION_B64}" ]; then
  write_env_var "ALEPH_BOOTSTRAP_OWNER_AUTHORIZATION_B64" "${BOOTSTRAP_OWNER_AUTHORIZATION_B64}"
fi
if [ -n "${BOOTSTRAP_REGISTRATION_ID}" ]; then
  write_env_var "ALEPH_BOOTSTRAP_REGISTRATION_ID" "${BOOTSTRAP_REGISTRATION_ID}"
fi
write_env_var "ALEPH_BOOTSTRAP_PROFILE" "orbitdb-relay-pinner"
touch "${READY_FILE}"

if [ "${START_SERVICE}" -eq 1 ]; then
  systemctl daemon-reload
  systemctl enable "${SERVICE_NAME}"
  systemctl restart "${SERVICE_NAME}"
  systemctl enable "${AUTOTLS_REFRESH_SERVICE}"
  systemctl enable "${BOOTSTRAP_REFRESH_TIMER}"
  systemctl start "${BOOTSTRAP_REFRESH_TIMER}"
  if [ -n "${PROXY_HOSTNAME}" ]; then
    write_caddyfile "${PROXY_HOSTNAME}"
    touch "${CADDY_READY_FILE}"
    systemctl enable "${CADDY_SERVICE}"
    systemctl restart "${CADDY_SERVICE}"
  else
    rm -f "${CADDY_READY_FILE}"
    systemctl stop "${CADDY_SERVICE}" || true
  fi
  systemctl restart --no-block "${AUTOTLS_REFRESH_SERVICE}"
fi

printf 'Configured VITE_APPEND_ANNOUNCE=%s\n' "${announce_value}"
printf 'Ready file: %s\n' "${READY_FILE}"
