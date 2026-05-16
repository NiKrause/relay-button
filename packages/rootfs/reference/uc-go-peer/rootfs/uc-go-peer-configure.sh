#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${ENV_FILE:-/etc/default/uc-go-peer}"
READY_FILE="${READY_FILE:-/etc/default/uc-go-peer.ready}"
AUTOTLS_READY_FILE="${AUTOTLS_READY_FILE:-/etc/default/uc-go-peer.autotls-ready}"
AUTOTLS_ZONE_FILE="${AUTOTLS_ZONE_FILE:-/etc/default/uc-go-peer.autotls-zone}"
AUTOTLS_HOSTS_FILE="${AUTOTLS_HOSTS_FILE:-/etc/default/uc-go-peer.autotls-hosts}"
AUTOTLS_CADDY_READY_FILE="${AUTOTLS_CADDY_READY_FILE:-/etc/default/uc-go-peer.caddy-ready}"
SERVICE_NAME="${SERVICE_NAME:-uc-go-peer.service}"
AUTOTLS_REFRESH_SERVICE="${AUTOTLS_REFRESH_SERVICE:-uc-go-peer-autotls-refresh.service}"
CADDY_SERVICE="${CADDY_SERVICE:-caddy.service}"
CADDYFILE="${CADDYFILE:-/etc/caddy/Caddyfile}"
BOOTSTRAP_SERVICE="${BOOTSTRAP_SERVICE:-uc-go-peer-bootstrap.service}"
P2P_FORGE_DOMAIN="${P2P_FORGE_DOMAIN:-libp2p.direct}"
PUBLIC_IPV4=""
PUBLIC_IPV6=""
TCP_PORT="9095"
WS_PORT="9097"
WS_BACKEND_PORT="9096"
PROXY_HOSTNAME=""
UDP_PORT=""
START_SERVICE=1

usage() {
  cat <<'EOF'
Usage:
  uc-go-peer-configure.sh \
    --public-ipv4 <ip> \
    [--public-ipv6 <ipv6>] \
    [--proxy-hostname <hostname>] \
    [--tcp-port <host-port>] \
    [--ws-port <host-port>] \
    [--udp-port <host-port>] \
    [--quic-port <host-port>] \
    [--webtransport-port <host-port>] \
    [--webrtc-port <host-port>] \
    [--no-start]
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

render_proxy_caddyfile() {
  local proxy_hostname="$1"
  cat <<EOF
{
    auto_https disable_redirects
}

https://${proxy_hostname} {
    tls {
        issuer acme {
            disable_http_challenge
        }
    }
    reverse_proxy http://127.0.0.1:${WS_BACKEND_PORT}
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
    --udp-port)
      UDP_PORT="${2:-}"
      shift 2
      ;;
    --proxy-hostname)
      PROXY_HOSTNAME="${2:-}"
      shift 2
      ;;
    --quic-port)
      UDP_PORT="${2:-}"
      shift 2
      ;;
    --webtransport-port)
      UDP_PORT="${2:-}"
      shift 2
      ;;
    --webrtc-port)
      UDP_PORT="${2:-}"
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
rm -f "${AUTOTLS_READY_FILE}" "${AUTOTLS_ZONE_FILE}" "${AUTOTLS_HOSTS_FILE}" "${AUTOTLS_CADDY_READY_FILE}"

announce=(
  "/ip4/${PUBLIC_IPV4}/tcp/${TCP_PORT}"
)

if [ -n "${WS_PORT}" ]; then
  announce+=("/ip4/${PUBLIC_IPV4}/tcp/${WS_PORT}/tls/sni/*.${P2P_FORGE_DOMAIN}/ws")
fi

if [ -n "${UDP_PORT}" ]; then
  announce+=(
    "/ip4/${PUBLIC_IPV4}/udp/${UDP_PORT}/quic-v1"
    "/ip4/${PUBLIC_IPV4}/udp/${UDP_PORT}/quic-v1/webtransport"
    "/ip4/${PUBLIC_IPV4}/udp/${UDP_PORT}/webrtc-direct"
  )
fi

if [ -n "${PUBLIC_IPV6}" ]; then
  announce+=("/ip6/${PUBLIC_IPV6}/tcp/${TCP_PORT}")
  if [ -n "${WS_PORT}" ]; then
    announce+=("/ip6/${PUBLIC_IPV6}/tcp/${WS_PORT}/tls/sni/*.${P2P_FORGE_DOMAIN}/ws")
  fi
  if [ -n "${UDP_PORT}" ]; then
    announce+=(
      "/ip6/${PUBLIC_IPV6}/udp/${UDP_PORT}/quic-v1"
      "/ip6/${PUBLIC_IPV6}/udp/${UDP_PORT}/quic-v1/webtransport"
      "/ip6/${PUBLIC_IPV6}/udp/${UDP_PORT}/webrtc-direct"
    )
  fi
fi

announce_value="$(IFS=,; printf '%s' "${announce[*]}")"
write_env_var "PUBLIC_IPV4" "${PUBLIC_IPV4}"
if [ -n "${PUBLIC_IPV6}" ]; then
  write_env_var "PUBLIC_IPV6" "${PUBLIC_IPV6}"
fi
write_env_var "EXTERNAL_RELAY_TCP_PORT" "${TCP_PORT}"
write_env_var "EXTERNAL_RELAY_WS_PORT" "${WS_PORT}"
write_env_var "GO_PEER_WSS_PORT" "${GO_PEER_WSS_PORT:-9097}"
if [ -n "${PROXY_HOSTNAME}" ]; then
  write_env_var "PROXY_HOSTNAME" "${PROXY_HOSTNAME}"
  mkdir -p "$(dirname "${CADDYFILE}")"
  render_proxy_caddyfile "${PROXY_HOSTNAME}" > "${CADDYFILE}"
  touch "${AUTOTLS_CADDY_READY_FILE}"
else
  write_env_var "PROXY_HOSTNAME" ""
  rm -f "${AUTOTLS_CADDY_READY_FILE}"
fi
if [ -n "${UDP_PORT}" ]; then
  write_env_var "EXTERNAL_RELAY_UDP_PORT" "${UDP_PORT}"
  write_env_var "EXTERNAL_RELAY_QUIC_PORT" "${UDP_PORT}"
  write_env_var "EXTERNAL_RELAY_WEBTRANSPORT_PORT" "${UDP_PORT}"
  write_env_var "EXTERNAL_RELAY_WEBRTC_PORT" "${UDP_PORT}"
fi
write_env_var "LIBP2P_ANNOUNCE_ADDRS" "${announce_value}"
touch "${READY_FILE}"

if [ "${START_SERVICE}" -eq 1 ]; then
  systemctl daemon-reload
  systemctl enable "${SERVICE_NAME}"
  systemctl restart "${SERVICE_NAME}"
  systemctl enable "${AUTOTLS_REFRESH_SERVICE}"
  if [ -n "${PROXY_HOSTNAME}" ]; then
    systemctl enable "${CADDY_SERVICE}"
    systemctl restart "${CADDY_SERVICE}"
  else
    systemctl stop "${CADDY_SERVICE}" || true
  fi
  systemctl restart --no-block "${AUTOTLS_REFRESH_SERVICE}"
fi

printf 'Configured LIBP2P_ANNOUNCE_ADDRS=%s\n' "${announce_value}"
printf 'Ready file: %s\n' "${READY_FILE}"
