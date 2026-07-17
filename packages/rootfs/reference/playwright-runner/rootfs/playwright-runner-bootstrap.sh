#!/usr/bin/env bash
set -euo pipefail

ENV_FILE=/etc/default/playwright-runner
TLS_CERT=/etc/playwright-runner/tls.crt
TLS_KEY=/etc/playwright-runner/tls.key

test -s "${ENV_FILE}"
test -s "${TLS_CERT}"
test -s "${TLS_KEY}"

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

test "${PLAYWRIGHT_VERSION:-}" = "1.61.1"
test -n "${PLAYWRIGHT_RUNNER_SECRET:-}"

chown root:playwright-proxy "${TLS_CERT}" "${TLS_KEY}"
chmod 0644 "${TLS_CERT}"
chmod 0640 "${TLS_KEY}"

systemctl restart playwright-runner.service
systemctl restart playwright-runner-proxy.service
systemctl restart playwright-runner-ttl.timer
