#!/usr/bin/env bash
# encrypt-image.sh <image>: encrypts a plain rootfs image in place, with the
# passphrase read from stdin (no CR/LF). The result is what Aleph's measured
# init opens: whole-device LUKS2, aes-xts-plain64, the filesystem inside.
#
# cryptsetup does the encryption itself here (no device-mapper, no loop
# device), so this runs in a container without extra privileges. The file
# grows by 32 MiB: 16 MiB for the LUKS2 header, and as much unused room behind
# the filesystem, which the instance grows into at boot.
set -euo pipefail
image="${1:?usage: encrypt-image.sh <image> < passphrase}"
[ -f "$image" ] || { echo "no such image: $image" >&2; exit 1; }
size="$(stat -c %s "$image")"
[ "$size" -gt 0 ] && [ $(( size % 4096 )) = 0 ] || { echo "the image is empty or no whole number of 4 KiB blocks" >&2; exit 1; }
truncate -s $(( size + 32 * 1048576 )) "$image"
cryptsetup reencrypt --encrypt --type luks2 --cipher aes-xts-plain64 --key-size 512 \
  --reduce-device-size 32M --batch-mode --key-file - "$image" >/dev/null
# A header that still asks for an unfinished re-encryption would not open.
if cryptsetup luksDump "$image" | grep -qi 'reencrypt'; then
  echo "the encryption did not finish" >&2; exit 1
fi
