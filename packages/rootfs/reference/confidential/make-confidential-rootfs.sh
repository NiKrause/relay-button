#!/usr/bin/env bash
# Turn a relay profile image (the qcow2 or raw disk the profile build makes)
# into a plain ext4 rootfs that `aleph instance create --confidential
# --encrypt-rootfs` can encrypt and boot on an SEV-SNP node.
#
#   make-confidential-rootfs.sh <image> <out.ext4> <authorized_keys>
#
# What changes in the image, and why:
# - /sbin/init becomes confidential-init.sh (a regular file, as the measured
#   init requires): systemd cannot be PID 1 in the chroot.
# - /usr/bin/systemctl and /usr/bin/journalctl become docker-systemctl-
#   replacement, pinned below, behind confidential-systemctl.py, which runs
#   .timer units; the profile's units and scripts keep working.
# - cloud-init and the systemd services that manage what the measured init
#   already did (network, DNS, getty, timesyncd) are no longer started.
# - Type=notify units run as Type=simple, and the init lets any user bind
#   ports below 1024 (the replacement has neither sd_notify nor capabilities).
# - root's authorized_keys come from the caller: nothing provisions an
#   encrypted rootfs from outside. Host keys are removed and made on first boot.
# - Kernel, modules, docs and caches go: the guest runs the runtime's measured
#   kernel, and the encrypted image must stay below the CCN's 1 GiB upload limit.
#
# Needs root (qemu-nbd, mount), qemu-utils, rsync, e2fsprogs and curl.
set -euo pipefail

SYSTEMCTL_REPLACEMENT_COMMIT=8bd65bec50650fcc740e2d55c32162ba7bafdfc8 # v1.7.1097
SYSTEMCTL3_SHA256=5f5a47f321c7a8881dfd01f774106dc4012d664bee238eada86a7112674fea93
JOURNALCTL3_SHA256=16a52fe484d7c0fca464c82a56de58980440362942482c0d1fbc424e69f8f833
MAX_PLAIN_MIB="${MAX_PLAIN_MIB:-900}"

image="${1:?usage: make-confidential-rootfs.sh <image> <out.ext4> <authorized_keys>}"
out="${2:?missing output path}"
keys="${3:?missing authorized_keys file}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
[ -s "$keys" ] || { echo "authorized_keys file is empty: $keys" >&2; exit 1; }

work="$(mktemp -d)"
mnt="$work/mnt"
root="$work/root"
nbd=""
cleanup() {
  mountpoint -q "$mnt" && umount "$mnt"
  [ -n "$nbd" ] && qemu-nbd -d "$nbd" >/dev/null 2>&1
  rm -rf "$work"
}
trap cleanup EXIT
mkdir -p "$mnt" "$root"

# 1. Mount the image's root filesystem (the largest ext4 partition).
modprobe nbd max_part=16
nbd=/dev/nbd0
qemu-nbd -r -c "$nbd" "$image"
udevadm settle
part="$(lsblk -lnbo NAME,FSTYPE,SIZE "$nbd" | awk '$2 == "ext4" { print $3, $1 }' | sort -n | tail -1 | cut -d' ' -f2)"
[ -n "$part" ] || { echo "no ext4 partition in $image" >&2; exit 1; }
mount -o ro "/dev/$part" "$mnt"

# 2. Copy it, leaving out what a confidential guest never uses.
rsync -aHAX --numeric-ids \
  --exclude=/boot/ --exclude=/usr/lib/modules/ --exclude=/lib/modules/ \
  --exclude=/usr/share/doc/ --exclude=/usr/share/man/ --exclude=/usr/share/info/ \
  --exclude=/usr/share/locale/ --exclude=/var/cache/apt/ --exclude=/var/lib/apt/lists/ \
  --exclude=/var/log/ --exclude=/var/lib/cloud/ --exclude=/tmp/ \
  "$mnt/" "$root/"
mkdir -p "$root"/{boot,var/log,tmp,var/cache/apt,var/lib/apt/lists}
chmod 1777 "$root/tmp"
umount "$mnt"

# 3. The systemd replacement.
fetch() {
  curl -fsSL -o "$2" "https://raw.githubusercontent.com/gdraheim/docker-systemctl-replacement/${SYSTEMCTL_REPLACEMENT_COMMIT}/files/docker/$1"
  echo "$3  $2" | sha256sum -c - >/dev/null
}
fetch systemctl3.py "$work/systemctl3.py" "$SYSTEMCTL3_SHA256"
fetch journalctl3.py "$work/journalctl3.py" "$JOURNALCTL3_SHA256"
for bin in systemctl journalctl; do
  for dir in usr/bin bin; do
    [ -e "$root/$dir/$bin" ] && [ ! -L "$root/$dir/$bin" ] && mv "$root/$dir/$bin" "$root/$dir/$bin.systemd"
  done
done
install -d "$root/usr/lib/confidential"
install -m 755 "$work/systemctl3.py" "$root/usr/lib/confidential/systemctl3.py"
# The replacement does not run .timer units; this wrapper does, and passes
# everything else on.
install -m 755 "$here/confidential-systemctl.py" "$root/usr/bin/systemctl"
install -m 755 "$work/journalctl3.py" "$root/usr/bin/journalctl"
# journalctl3.py calls systemctl3.py from its own directory.
ln -sf /usr/lib/confidential/systemctl3.py "$root/usr/bin/systemctl3.py"
[ -x "$root/usr/bin/python3" ] || { echo "the image has no python3, which the systemctl replacement needs" >&2; exit 1; }

# 4. Stop starting what the measured init already did, or what has no place here.
wants="$root/etc/systemd/system"
find "$wants" -path '*.wants/*' \( \
  -name 'cloud-*' -o -name 'systemd-networkd*' -o -name 'systemd-resolved*' \
  -o -name 'systemd-timesyncd*' -o -name 'networking.service' -o -name 'getty@*' \
  -o -name 'serial-getty@*' -o -name 'e2scrub*' -o -name 'fstrim*' -o -name 'apt-daily*' \
  -o -name 'man-db*' -o -name 'unattended-upgrades*' -o -name 'systemd-pstore*' \
  -o -name 'qemu-guest-agent*' -o -name 'remote-fs.target' \) -delete
# cloud-init is also pulled in from units under /lib; nothing may start it.
find "$root/etc/systemd" "$root/lib/systemd/system" "$root/usr/lib/systemd/system" \
  -name 'cloud-*' \( -type l -o -type f \) -delete 2>/dev/null || true
rm -f "$root/usr/bin/cloud-init" "$root/usr/bin/cloud-id"
[ -s "$root/etc/hostname" ] || echo relay > "$root/etc/hostname"

# 4b. Units the replacement cannot run as written (relay-button#168): it does
# not receive sd_notify readiness, so Type=notify becomes Type=simple (a
# reverse proxy such as Caddy needs no readiness handshake here); and it does
# not apply AmbientCapabilities, so low ports are opened to every user by the
# init (net.ipv4.ip_unprivileged_port_start=0) instead.
for dir in "$root/etc/systemd/system" "$root/lib/systemd/system" "$root/usr/lib/systemd/system"; do
  [ -d "$dir" ] || continue
  # grep exits 1 when a directory has none; under pipefail that would end the script.
  {   grep -rlE '^Type=notify(-reload)?$' "$dir" --include='*.service' 2>/dev/null || true; } | while read -r unit; do
    sed -i -E 's/^Type=notify(-reload)?$/Type=simple/; /^NotifyAccess=/d' "$unit"
    echo "Type=notify -> simple: ${unit#$root}"
  done
done

# 5. Init, DNS placeholder, SSH.
rm -f "$root/sbin/init"
install -m 755 "$here/confidential-init.sh" "$root/sbin/init"
rm -f "$root/etc/resolv.conf"
touch "$root/etc/resolv.conf"
rm -f "$root"/etc/ssh/ssh_host_*
install -d -m 700 "$root/root/.ssh"
install -m 600 "$keys" "$root/root/.ssh/authorized_keys"
ln -sf /lib/systemd/system/ssh.service "$wants/multi-user.target.wants/ssh.service" 2>/dev/null || true

# 6. A tight ext4: the CRN grows the disk, the init grows the filesystem.
size_mib=$(( $(du -sm "$root" | cut -f1) * 110 / 100 + 64 ))
echo "rootfs content: $(du -sh "$root" | cut -f1), plain image ${size_mib} MiB"
[ "$size_mib" -le "$MAX_PLAIN_MIB" ] || {
  echo "largest directories:" >&2
  du -xm --max-depth=4 "$root" 2>/dev/null | sort -n | tail -30 | sed "s|$root||" >&2
  echo "the plain image (${size_mib} MiB) is above ${MAX_PLAIN_MIB} MiB and would exceed the 1 GiB upload limit once encrypted" >&2
  exit 1
}
rm -f "$out"
truncate -s "${size_mib}M" "$out"
mkfs.ext4 -q -b 4096 -T default -d "$root" "$out"
echo "wrote $out"
