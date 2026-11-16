#!/usr/bin/env bash
# build-archive.sh [out.tar]: the builder's container image as an archive for
# `aleph vprogram … --image-archive`, built for linux/amd64 under the name the
# compose file uses. Prints the archive's SHA-256. Needs docker (or podman
# with DOCKER=podman).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="${1:-$here/image-builder.tar}"
docker="${DOCKER:-docker}"
image="$(sed -n 's/^ *image: *//p' "$here/docker-compose.yml")"
[ -n "$image" ] || { echo "no image in docker-compose.yml" >&2; exit 1; }
"$docker" build --platform linux/amd64 -f "$here/../Containerfile" -t "$image" "$here/.." >&2
"$docker" save -o "$out" "$image"
echo "image:   $image"
echo "archive: $out"
echo "sha256:  $(sha256sum "$out" 2>/dev/null | cut -d' ' -f1 || shasum -a 256 "$out" | cut -d' ' -f1)"
