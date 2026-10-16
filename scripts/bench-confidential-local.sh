#!/usr/bin/env bash
# The local half of the confidential deploy benchmark: the same phases
# aleph-vm-deploy times in timings_json (created, processed, attested,
# unlocked, runtime), driven by Aleph's CLI on this machine, against the same
# encrypted rootfs and node. Compare with the action's timings_json for a run
# with the same ROOTFS and CRN (workflow "Aleph Confidential Deploy Smoke").
#
#   ROOTFS=<encrypted rootfs STORE hash> CRN=<node hash> \
#   PASSPHRASE_FILE=<file with the rootfs passphrase> \
#   [ACCOUNT=<aleph CLI account name>] [SIZE=2vcpu-4gb] [KEEP=1] \
#   scripts/bench-confidential-local.sh
#
# Spends a few cents of credits; the instance is forgotten at the end unless
# KEEP=1. Needs: aleph (aleph-rs CLI), curl, jq.
set -euo pipefail

: "${ROOTFS:?set ROOTFS to the encrypted rootfs STORE item hash}"
: "${CRN:?set CRN to the SEV-SNP node hash}"
: "${PASSPHRASE_FILE:?set PASSPHRASE_FILE to a file holding the rootfs passphrase}"
API="${API:-https://api2.aleph.im}"
VCPUS="${VCPUS:-2}"
MEMORY_MIB="${MEMORY_MIB:-4096}"
DISK_MIB="${DISK_MIB:-20480}"
account_args=()
[ -n "${ACCOUNT:-}" ] && account_args=(--account "$ACCOUNT")

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
# The CLI wants an authorized key on the message; the encrypted image carries
# its own, so a throwaway one is enough.
ssh-keygen -q -t ed25519 -N '' -C bench-local -f "$work/key"

start_ms=$(( $(date +%s) * 1000 ))
now_ms() { python3 -c 'import time; print(int(time.time()*1000))'; }
start_ms=$(now_ms)
timings=()
mark() { timings+=("$1 $(( $(now_ms) - start_ms ))"); printf '%-10s %6.1f s\n' "$1" "$(echo "scale=1; ($(now_ms) - $start_ms)/1000" | bc)"; }

name="bench-local-$(date +%s)"
out="$(aleph instance create "$name" --confidential --image "$ROOTFS" \
  --vcpus "$VCPUS" --memory "${MEMORY_MIB}MiB" --disk-size "${DISK_MIB}MiB" \
  --crn "$CRN" --ssh-pubkey-file "$work/key.pub" "${account_args[@]}" 2>&1)"
item="$(grep -oE 'Item hash: +[0-9a-f]{64}' <<<"$out" | grep -oE '[0-9a-f]{64}' | head -1 || true)"
[ -n "$item" ] || { echo "$out" >&2; exit 1; }
mark created
cleanup() {
  [ "${KEEP:-0}" = 1 ] && { echo "kept instance $item"; return; }
  echo y | aleph instance delete "$item" --reason "local confidential benchmark" "${account_args[@]}" >/dev/null 2>&1 \
    && echo "forgot instance $item"
}
trap 'cleanup; rm -rf "$work"' EXIT

until [ "$(curl -fsS "$API/api/v0/messages/$item" | jq -r .status 2>/dev/null)" = processed ]; do sleep 2; done
mark processed

crn_url="$(curl -fsS "$API/api/v0/aggregates/0xa1B3bb7d2332383D96b7796B908fB7f7F3c2Be10.json?keys=corechannel" \
  | jq -r --arg h "$CRN" '.data.corechannel.resource_nodes[] | select(.hash == $h) | .address')"
crn_url="${crn_url%/}"
# What aleph-vm-deploy does too: ask the node to allocate now.
curl -fsS -X POST "$crn_url/control/allocation/notify" -H 'content-type: application/json' \
  -d "{\"instance\":\"$item\"}" >/dev/null 2>&1 || true

for i in $(seq 1 12); do
  if aleph instance attest "$item" --crn "$CRN" --json > "$work/attest.json" 2> "$work/attest.err"; then break; fi
  grep -qE 'TCB below|KDS returned HTTP 4' "$work/attest.err" && { cat "$work/attest.err" >&2; exit 1; }
  sleep 15
done
[ "$(jq -r .verified "$work/attest.json" 2>/dev/null)" = true ] || { cat "$work/attest.err" >&2; exit 1; }
mark attested

aleph instance unlock "$item" --crn "$CRN" --passphrase-file "$PASSPHRASE_FILE" "${account_args[@]}" >/dev/null
mark unlocked

until curl -fsS --max-time 15 "$crn_url/v2/about/executions/list" \
  | jq -e --arg h "$item" '.[$h].networking.host_ipv4 // empty' >/dev/null; do sleep 2; done
mark runtime

printf '['; sep=''
for entry in "${timings[@]}"; do set -- $entry; printf '%s{"phase":"%s","ms":%s,"crn":"%s"}' "$sep" "$1" "$2" "$CRN"; sep=','; done
printf ']\n'
