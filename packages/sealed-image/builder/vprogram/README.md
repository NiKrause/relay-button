# The sealed image builder as an Aleph V-PROGRAM

How the builder (`../builder.mjs`, used by `@le-space/sealed-image`) gets
onto Aleph as a measured, confidential VM that anyone can attest.

One builder code, published once per plain image (decided 2026-11-15,
NiKrause/relay-button#225): a publication holds one plain image on a
verified volume, so its measurement names that image. Each app pins the
measurement of its own publication (`publications/` here keeps a record of
each) and changes it on its own release cycle.

> **Status:** this code ran on Aleph as Paperless anywhere's builder
> (Le-Space/paperless-anywhere#202): published, attested, sealing the real
> image, fetched through an attest relay and stored from a browser, round
> trips included (2026-11-16). Under this name and with the claim text
> `sealed image build` it has not been published yet; Paperless anywhere's
> pinned builder still signs with `paperless-anywhere image build`.

## What runs

| | |
|---|---|
| Runtime | `compose-1.4` (aleph-snp-compose 2.2.0): firmware, kernel, initrd and a read-only root with podman, all from Aleph's published bundle |
| Workload | one volume with `docker-compose.yml` and the builder's image archive; its dm-verity root hash is on the measured boot line |
| Plain image | a verified volume (`/volumes/0`, in the container `/plain`) with the plain image, gzipped; its root hash is on the boot line too |
| Way in | Aleph's attestation agent, TLS on 8443, forwarding to `127.0.0.1:8080` |
| Way out | none: the guest's firewall accepts only the attested port and drops the replies to outbound connections. The sealed image leaves through the attested channel, fetched by the caller |
| Scratch | none on disk: the image being built lies in memory (`/work`, a tmpfs of 1.2 GiB) |

A V-PROGRAM has no owner and takes no secret at start (Aleph refuses
`variables` for it: they would reach the guest unmeasured): what the builder
knows is what is in this repository, and the plain image. So the first
signed build request claims it for the address that signed it
(`builder/claim.mjs`); requests from other addresses are refused. The
passphrase of a build arrives over the attested channel and is gone when
the build ends.

Which image a builder seals is fixed when it is published, and is part of
its measurement. A new plain image needs a new builder.

**Memory:** 6144 MiB. The loaded container image (about 250 MiB), one image
of up to 1 GiB in `/work`, and up to 1 GiB while `cryptsetup` derives the
disk key all live in memory.

**Size:** the plain image may have 992 MiB at most, unpacked
(`MAX_IMAGE_BYTES`): sealing adds 32 MiB, and Aleph takes 1 GiB in one
upload. Paperless anywhere's plain image has 836 MiB, the Belege bridge's
959 MiB (33 MiB to spare). `/work` (1200 MiB) holds one sealed image of up
to 1 GiB; the publish workflow refuses a larger plain image before it
uploads anything.

## With the workflow

The workflow **Sealed image builder on Aleph** (`.github/workflows/sealed-image-builder-publish.yml`,
started by hand under *Actions*) runs the steps below on a GitHub runner, with
the pinned CLI and the secret `ALEPH_PRIVATE_KEY` as the account that signs
and pays. Its summary holds what each action found.

| Action | Does | Costs |
|---|---|---|
| `dry-run` | builds the archive and the workload, computes the launch measurements; uploads and publishes nothing | nothing |
| `publish` | a dry run first, then uploads the workload and publishes the V-PROGRAM, waits until it is reachable and makes an attested call to it; if that call does not verify, the builder is deleted again | credits of the account, from then on **until it is deleted** |
| `check` | shows the V-PROGRAM with the given hash and makes one attested call to `/`; fails unless the builder answers | nothing |
| `trial` | has the builder with the given hash seal the image once, with a passphrase made for the run and thrown away, and fetches two pieces back; fails unless the result begins as a LUKS2 disk | nothing beyond the running builder |
| `delete` | forgets the V-PROGRAM with the given hash; the scheduler then stops the VM | nothing; ends the cost |

The usual order:

0. The app's plain image as a STORE on Aleph: gzipped, as the app's image
   workflow publishes it (Paperless anywhere: `rootfs.yml` with the option
   *plain*). Note its STORE hash and the SHA-256 of the unpacked image.
   Every action below that builds takes them as `plain_store` and
   `plain_sha256`.
1. `dry-run`. If it fails while it fetches Aleph's runtime bundle, start it
   again; it tries three times by itself.
2. `publish`, with a node in `crn` (see below). Note the item hash from the
   summary. A green run means the attested call verified.
3. `trial` with that hash and `plain_sha256`: one whole build on Aleph.
   `check` with the hash, whenever you want to know whether it still
   answers.
4. Record the publication in `../publications/<app>.json` and enter the
   values in the app ([below](#what-goes-into-the-app-afterwards)).
5. `delete` with that hash. The volumes stay on Aleph, and an app starts
   its own V-PROGRAM from the recorded content for each build
   (`buildOnFreshBuilder`). `again` with hash `fixed` and a publication file
   starts one exactly that way, to try it. `forget_volumes` forgets the
   volumes too, guarded (`../../src/forget-guard.mjs`): only STOREs that
   V-PROGRAM names, of this account, smaller than any image, and named in
   no publication file.

### Choosing the node

An attested call verifies only on a node whose SEV-SNP firmware (its TCB:
bootloader, microcode and so on) is at or above the floor Aleph's network
sets. A node does not say how current its firmware is; only an attestation
shows it. So:

- Name a node in `crn` (its hash or a unique start of it): one of Aleph's
  compute nodes that reports `sev_snp` among its CPU features. Without it
  the scheduler chooses, and it does not look at the firmware.
- If the attested call fails, `publish` deletes the builder again and the
  summary says why. Try the next node.
- `keep` leaves a builder that failed the call running, to look at it with
  `aleph vprogram logs`. It keeps costing; delete it afterwards.

The first publication (2026-11-11, node chosen by the scheduler) ended this
way: the VM ran, and the attestation was refused because that node's
bootloader and microcode were below the floor.
The second, on a named node, verified (bootloader 10, microcode 88), but
the builder did not answer yet at the first call and the workflow of that
day deleted it too early; it now waits for the builder to come up.

`memory`, `vcpus` and `runtime` have the defaults this page explains; change
them only with a reason, since each changes the measurement.

A publication is not repeated automatically: if `publish` fails after the
upload began, look at the account's V-PROGRAMs (`aleph vprogram list`)
before starting it again, so that two builders do not run side by side.

Updating the CLI: set `ALEPH_CLI_VERSION` and `ALEPH_CLI_SHA256` at the top
of the workflow to a release of `aleph-im/aleph-rs` and the SHA-256 GitHub
lists for `aleph-cli-linux-x86_64`.

## By hand

The same on a Linux machine with the Aleph CLI, `veritysetup`
(`cryptsetup-bin`), `mkfs.ext4` (`e2fsprogs`) and docker. It does not work
on macOS: the CLI needs `veritysetup` and `mkfs.ext4` to build the workload.


All in this directory. `IMAGE` is the name in `docker-compose.yml`. With a
key instead of a stored account, set `ALEPH_PRIVATE_KEY` and add `--chain eth`.

```sh
IMAGE=localhost/sealed-image-builder:1
```

1. **The archive.** Built for linux/amd64; the script prints its SHA-256.
   The workflow *Sealed image builder* builds the same on a GitHub runner
   and keeps it as an artifact.

   ```sh
   ./build-archive.sh
   ```

   **The plain image as a volume:** a small ext4 filesystem holding the
   gzipped plain image under the name the compose file expects.

   ```sh
   mkdir vol && cp my-plain-image.ext4.gz vol/plain.img.gz
   truncate -s 280M plain-volume.ext4 && mkfs.ext4 -q -O ^has_journal -d vol plain-volume.ext4
   ```

2. **A local boot, nothing uploaded.** On a Linux machine with
   `qemu-system-x86_64`, `/dev/kvm` and `veritysetup`: boots Aleph's
   runtime with this workload in plain QEMU and asks the builder for `/`.
   It shows that the volume is built as the runtime wants it, that podman
   loads the archive and that the builder answers through the agent. It
   shows nothing about SEV-SNP, attestation or the node's network.

   ```sh
   aleph vprogram run --compose docker-compose.yml --image-archive "$IMAGE=image-builder.tar" \
     --volume plain-volume.ext4 --runtime compose-1.4 --vcpus 2 --memory 6144 --check
   ```

3. **What would be published.** Builds and measures, signs and uploads
   nothing; the output names the launch measurements.

   ```sh
   aleph vprogram create sealed-image-builder --compose docker-compose.yml \
     --image-archive "$IMAGE=image-builder.tar" --volume plain-volume.ext4 \
     --runtime compose-1.4 --vcpus 2 --memory 6144 --dry-run --json
   ```

4. **Publish.** The same without `--dry-run`, with `--wait`. From here on
   the builder costs credits of the signing account until it is deleted.

   ```sh
   aleph vprogram create sealed-image-builder --compose docker-compose.yml \
     --image-archive "$IMAGE=image-builder.tar" --volume plain-volume.ext4 \
     --runtime compose-1.4 --vcpus 2 --memory 6144 --wait 600
   ```

5. **An attested call.** Answers only if the AMD chain, the key binding,
   the pinned measurement, the policy and a fresh nonce all check out.
   Expected: `{"service":"sealed image builder","plain":null}`.

   ```sh
   aleph vprogram call <hash> / --verbose
   ```

6. **Stop it.**

   ```sh
   aleph vprogram delete <hash>
   ```

## What a trial has to show

- A whole job with the real plain image fits into the memory above, and
  how long it takes.
- `cryptsetup` encrypts inside the runtime's container. Locally it does so
  without device-mapper and without the kernel's crypto socket, which the
  guest kernel does not have.
- The sealed image comes back in pieces over the attested channel, and at
  which pace.

## What the runs showed so far (Paperless anywhere's builder)

- 2026-11-11, node chosen by the scheduler: the attestation was refused,
  that node's firmware is below the network's floor.
- 2026-11-11 and 12, on a named node: the attestation verifies, the builder
  comes up after about four minutes and answers `/`.
- 2026-11-12, a first build request with a real plain image: accepted over
  the attested channel, and failed at its first step with "fetch failed".
  The builder did not reach Aleph's API from inside the guest. Why is not
  known yet: the builder of that day did not say what lay behind the error.
- 2026-11-12, the same with a builder that reports what it reaches: name
  servers are set, no lookup and no connection gets an answer. The cause
  is the guest's firewall, by design: it accepts the attested port only, so
  no reply to an outbound connection comes back. A V-PROGRAM cannot fetch
  or upload; the builder was rebuilt around that (image on a verified
  volume, result handed back).

- 2026-11-12, the rebuilt builder, published with the plain image as a
  verified volume (257 MiB) and tried with the action `trial`: the build
  of the real image (836 MiB) was done within 36 s and gave a sealed image
  of 868 MiB; pieces came back over the attested channel, 4 MiB in about
  two seconds with the attestation of that call included. Aleph's CLI
  prints answers as text, so the bytes could not be compared there.

- 2026-11-13, a publication for the image with #168: the V-PROGRAM was
  processed and its endpoint named (the node's IPv4 and a mapped port),
  but the first attested call came seconds later, before the workload was
  up. The CLI reports that as "attestation failed: RA-TLS HTTP request
  failed", which the workflow took for a refused attestation and deleted
  the builder. It now waits when the call did not reach the guest.

## What goes into the app afterwards

The `builder` an app hands to `buildOnFreshBuilder` (`@le-space/sealed-image`):

- `program`: the V-PROGRAM content from `aleph vprogram show <hash>`, without
  `address` and `time` (each build sets its own);
- `crn`: the node it names; `measurements`, `policy`: from its `verification`;
- `plain`: the SHA-256 (and, to show it, the STORE hash and the commit) of the plain image this builder was published with;
- `claim`: `sealed image build` (the default) for a builder from this code.

`templateMismatches` (`@le-space/aleph-vm`) checks that the four agree. All
of these are public values. The same goes into `../publications/<app>.json`.

## Checking it from outside

The V-PROGRAM message names the runtime, the workload volume, its hash
tree and root hash, and the measurements. Anyone can download the volume,
verify it against the root hash (`veritysetup verify`), read the compose
file in it and load the image archive, and recompute the measurement from
Aleph's runtime bundle and the boot line.

Two limits, said plainly:

- The hash tree gets a random salt at each `create`, so a new publication
  of the same files has another root hash and another measurement. The
  measurement fixed in the app belongs to one publication.
- The container image is not built reproducibly yet (Debian packages are
  installed at build time). What can be compared is its content, not its
  hash against a rebuild.
