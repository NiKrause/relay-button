# Confidential relay rootfs

A confidential (AMD SEV-SNP) instance on Aleph does not boot a rootfs the way a
normal instance does. Aleph's measured init waits for the owner to attest the
guest and inject the LUKS passphrase, unlocks the rootfs, **chroots** into it and
runs its `/sbin/init`. That init is not PID 1, nothing provisions the image from
outside (no cloud-init), and the encrypted image is uploaded in full.

`make-confidential-rootfs.sh` turns the image a relay profile build makes into
a plain ext4 that `aleph instance create --confidential --encrypt-rootfs` (or
`--image`, see below) can boot:

| Change | Why |
| --- | --- |
| `/sbin/init` → `confidential-init.sh` | a regular file that stays in the foreground: mounts `/run`, devpts and cgroup2, grows the filesystem (`EXT4_IOC_RESIZE_FS`, since `resize2fs` refuses in the chroot), makes SSH host keys on first boot, then runs `systemctl init` |
| `systemctl`, `journalctl` → [docker-systemctl-replacement](https://github.com/gdraheim/docker-systemctl-replacement) (pinned, checksummed) behind `confidential-systemctl.py` | starts the enabled units and keeps answering the `systemctl` / `journalctl` calls the profile scripts make, so the profile itself does not change; the wrapper runs `.timer` units (OnBootSec / OnActiveSec, then OnUnitActiveSec, with RandomizedDelaySec), which the replacement does not |
| cloud-init, networkd, resolved, timesyncd, getty, … off | the measured init already set up network and DNS |
| `Type=notify` units run as `Type=simple`; the init sets `net.ipv4.ip_unprivileged_port_start=0` | the replacement receives no sd_notify readiness and applies no `AmbientCapabilities`, so Caddy (WSS on 443) would not start (#168) |
| root's `authorized_keys` from the caller, host keys removed | an encrypted rootfs cannot be provisioned from outside; host keys exist only inside it |
| no kernel, modules, docs, locales, apt caches | the guest runs the runtime's measured kernel; the image should stay small |

## Image size

`aleph instance create --encrypt-rootfs` uploads through the CCN, which takes at
most 1 GiB per file. Above ~900 MiB plain, encrypt the image yourself (LUKS2,
`--cipher aes-xts-plain64`, whole device, ext4 inside: the measured init
rejects any other cipher), add it through `ipfs.aleph.cloud`, reference it from
a STORE message and start it with `aleph instance create --confidential --image
<store hash>`. The **Aleph Confidential Relay Smoke** workflow does both.
orbitdb-relay is 1.7 GiB plain today; slimming it is #161.

## Known gaps

- Timers are approximated: no OnCalendar, no Persistent catch-up across a
  reboot (an encrypted instance re-waits for its passphrase after one anyway).
- `aleph-vm-deploy` takes `confidential: true` with an encrypted rootfs from
  `.github/actions/aleph-confidential-rootfs`.
