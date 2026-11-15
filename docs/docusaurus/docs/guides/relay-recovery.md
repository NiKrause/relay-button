---
title: Bring back a relay that came back blank
description: Why a relay VM on Aleph can come back unconfigured after its execution was torn down, and how to configure it again with one command and the owner's signature.
---

# Bring back a relay that came back blank

A relay VM on Aleph survives a reboot. It does not survive losing its
execution. If a relay is running again after a pause but its 2n6 name gives
no TLS or a 503, and port 80 of the VM answers
`{"status": "waiting-for-port-mapping", "ready": false}`, this page is for you.

## What happened

aleph-vm ends a VM in one of two ways:

| Trigger | aleph-vm reason | Disk and ports | The relay afterwards |
|---|---|---|---|
| reboot, crash, message amend | `RECREATE` | kept | starts normally |
| credits ran out, message forgotten, scheduler deallocation, migration | `GONE` | by default (`VOLUME_RETENTION=reap`) the disk is **purged**, the ports are released | comes back from the parent image, **unconfigured** |

After a `GONE`, the instance hash, its 2n6 hostname and, on the same CRN, its
IPv6 address stay the same. Everything the guest learned is gone:
- its libp2p identity (peer ID);
- its bootstrap publisher key;
- its certificates and its configuration.

The CRN also maps new host ports.

A relay deployed with the push handoff has no record to configure itself from.
So its setup server waits on port 80 for a `POST /configure` that nobody sends.
The guest's log says so:

```
no aleph-bootstrap-config marker in /root/.ssh/authorized_keys; nothing to poll for, the relay will stay unconfigured
```

This happened to the uc-go-peer `41922e22…` on 2026-10-13 (#153). It also
happened to the orbitdb-relay attest relay `c29417eb…` on 2026-11-15, after its
paying account reached zero credits. Making a relay configure itself in this
case, and warning before an account runs dry, is tracked in #233.

## Configure it again

`relay-reconfigure` does the recovery in two steps, because the instance
owner signs in between. It supports the `orbitdb-relay` profile.

**1. Prepare.** From the repository root:

```bash
pnpm relay-button relay-reconfigure prepare --instance <instance-item-hash>
```

It does the following:
- reads the INSTANCE message: its owner, name and CRN;
- reads the CRN's **current** port mapping and the 2n6 hostname;
- checks that the guest is waiting for its configuration. It refuses
  otherwise, and then there is nothing to do.

It then generates a new publisher key and libp2p identity. These go into
`relay-reconfigure-<hash>.json`, mode `0600`, together with everything `apply`
needs. Finally it prints a single line of JSON: the owner authorization for
the new peer ID and publisher address.

**2. Sign.** Sign exactly that line with the **instance owner's** account
(`personal_sign`), for example in MetaMask. With Foundry:

```bash
cast wallet sign --interactive "<the printed line>"
```

The signature is public. The owner's key never leaves the owner.

**3. Apply.**

```bash
pnpm relay-button relay-reconfigure apply --state relay-reconfigure-<hash>.json --signature 0x…
```

It does the following, and stops at the first failure:
1. checks that the signature recovers to the owner;
2. checks again that the guest is still waiting;
3. sends `POST /configure` with the new ports, the 2n6 hostname, the generated
   keys, the signed authorization and the registration ID
   `relay:<profile>:<name>:<instance-hash>`. The IPv6 address is left out (see
   the 0.12.8 notes);
4. waits until `https://<2n6-name>/health` reports the new peer ID;
5. fetches `/metadata`, which shuts the setup server down, as the end of a
   normal deploy does;
6. waits until the bootstrap channel carries a registration with that
   registration ID and peer ID.

It then deletes the state file: the keys now live only on the guest.

## What to expect afterwards

- **New peer ID and publisher address.** The old identity cannot be recovered.
  Consumers that look relays up by registration ID and 2n6 hostname, such as
  simple-todo and paperless-anywhere, find the relay again without a change.
- **An old registration left behind.** The registration from before the
  teardown stays on the channel until it ages out. Consumers that pick the
  newest post per registration ID see the new one.
- **The same image as before.** For a relay that needs a newer image, for
  example for attest-relay builder limits, deploy a new instance instead.
