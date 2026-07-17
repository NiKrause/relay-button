#!/usr/bin/env bash
set -euo pipefail

: "${RUNNER_HOST:?}"
: "${RUNNER_SSH_PORT:?}"
: "${RUNNER_SSH_KEY:?}"
: "${RUNNER_SECRET:?}"
: "${RUNNER_CA_CERT:?}"

ACTION_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CADDY_FILE="${ACTION_DIR}/../../../packages/rootfs/reference/playwright-runner/rootfs/Caddyfile"
test -s "${CADDY_FILE}"

echo "::add-mask::${RUNNER_SECRET}"
openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 1 \
  -subj '/CN=aleph-playwright-runner' \
  -addext "subjectAltName=IP:${RUNNER_HOST}" \
  -keyout "${RUNNER_CA_CERT}.key" -out "${RUNNER_CA_CERT}" 2>/dev/null
chmod 600 "${RUNNER_CA_CERT}.key"

ssh_opts=(-i "$RUNNER_SSH_KEY" -p "$RUNNER_SSH_PORT" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20)
scp_opts=(-i "$RUNNER_SSH_KEY" -P "$RUNNER_SSH_PORT" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20)
ready=false
for _ in $(seq 1 60); do
  if ssh "${ssh_opts[@]}" root@"$RUNNER_HOST" true 2>/dev/null; then ready=true; break; fi
  sleep 5
done
if [ "$ready" != true ]; then
  echo 'SSH endpoint did not become ready.' >&2
  exit 1
fi

env_file="$(mktemp)"
trap 'rm -f "$env_file" "${RUNNER_CA_CERT}.key"' EXIT
chmod 600 "$env_file"
printf 'PLAYWRIGHT_VERSION=1.61.1\nPLAYWRIGHT_RUNNER_SECRET=%s\n' "$RUNNER_SECRET" >"$env_file"
scp "${scp_opts[@]}" "$env_file" root@"$RUNNER_HOST":/etc/default/playwright-runner
scp "${scp_opts[@]}" "$CADDY_FILE" root@"$RUNNER_HOST":/etc/playwright-runner/Caddyfile
scp "${scp_opts[@]}" "$RUNNER_CA_CERT" root@"$RUNNER_HOST":/etc/playwright-runner/tls.crt
scp "${scp_opts[@]}" "${RUNNER_CA_CERT}.key" root@"$RUNNER_HOST":/etc/playwright-runner/tls.key
if ! ssh "${ssh_opts[@]}" root@"$RUNNER_HOST" \
  'chmod 0600 /etc/default/playwright-runner /etc/playwright-runner/tls.key; systemctl start playwright-runner-bootstrap.service; sleep 3; systemctl is-active --quiet playwright-runner.service playwright-runner-proxy.service; set -a; . /etc/default/playwright-runner; set +a; test "$(curl --fail --silent --show-error --insecure -H "Authorization: Bearer ${PLAYWRIGHT_RUNNER_SECRET}" https://127.0.0.1/version)" = "{\"playwrightVersion\":\"1.61.1\"}"'; then
  echo 'Playwright runner services did not become active. Guest diagnostics follow.' >&2
  ssh "${ssh_opts[@]}" root@"$RUNNER_HOST" \
    'systemctl status --no-pager --full playwright-runner-bootstrap.service playwright-runner.service playwright-runner-proxy.service >&2 || true; journalctl --no-pager --lines=120 -u playwright-runner-bootstrap.service -u playwright-runner.service -u playwright-runner-proxy.service >&2 || true' || true
  exit 1
fi
