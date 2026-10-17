#!/bin/sh
# /sbin/init of a confidential (SEV-SNP) relay rootfs.
#
# Aleph's measured init unlocks the LUKS rootfs, chroots into it and runs this
# file. It is not PID 1, so systemd cannot run; docker-systemctl-replacement
# starts the enabled units instead and keeps answering the `systemctl` and
# `journalctl` calls the profile scripts make; confidential-systemctl.py
# (/usr/bin/systemctl) adds the .timer units it does not run.
# This script must stay in the foreground: when it exits, the VM powers off.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

mkdir -p /run /dev/pts /sys/fs/cgroup /var/log
mount -t tmpfs -o mode=755 tmpfs /run
mkdir -p /run/sshd /run/lock
mount -t devpts -o gid=5,mode=620,ptmxmode=666 devpts /dev/pts 2>/dev/null
mountpoint -q /sys/fs/cgroup || mount -t cgroup2 none /sys/fs/cgroup 2>/dev/null
[ -s /etc/hostname ] && hostname -F /etc/hostname 2>/dev/null
# Units that bind low ports rely on AmbientCapabilities=CAP_NET_BIND_SERVICE,
# which the systemctl replacement does not apply (relay-button#168).
echo 0 > /proc/sys/net/ipv4/ip_unprivileged_port_start 2>/dev/null

# The CRN grows the disk, not the filesystem inside the LUKS volume, and
# resize2fs refuses in the chroot (it does not see / as mounted), so ask the
# kernel to grow it online (EXT4_IOC_RESIZE_FS).
if [ -b /dev/mapper/cryptroot ]; then
  bs=$(tune2fs -l /dev/mapper/cryptroot 2>/dev/null | sed -n 's/^Block size: *//p')
  if [ -n "$bs" ]; then
    blocks=$(( $(blockdev --getsize64 /dev/mapper/cryptroot) / bs ))
    perl -e 'sysopen(my $f, "/", 0) or die "open: $!"; ioctl($f, 0x40086610, pack("Q", $ARGV[0])) or die "EXT4_IOC_RESIZE_FS: $!\n"' "$blocks" \
      > /var/log/confidential-resize.log 2>&1
  fi
fi

# Host keys are made on the first boot, inside the encrypted disk, so they
# never exist outside it.
ls /etc/ssh/ssh_host_*_key >/dev/null 2>&1 || ssh-keygen -A > /dev/null 2>&1

# Keys injected with the passphrase over the attested channel (the widget
# sends the deployer's key with its bootstrap token there, since nothing reads
# the INSTANCE message's authorized_keys here). Key lines only, no options.
if [ -s /tmp/secrets/authorized_keys ]; then
  mkdir -p -m 700 /root/.ssh
  touch /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys
  grep -E '^(ssh-(rsa|ed25519)|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com) [A-Za-z0-9+/]+={0,3}( [^[:cntrl:]]*)?$' /tmp/secrets/authorized_keys \
    | while read -r line; do
        grep -qxF "$line" /root/.ssh/authorized_keys || printf '%s\n' "$line" >> /root/.ssh/authorized_keys
      done
fi

echo "confidential-init: $(uname -r), starting the enabled units" > /dev/console
/usr/bin/python3 /usr/bin/systemctl __start-enabled-timers
exec /usr/bin/python3 /usr/lib/confidential/systemctl3.py init
