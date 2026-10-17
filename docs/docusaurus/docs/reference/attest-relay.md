# Attest relay

A confidential start from the widget ends with the browser checking the VM
itself: it opens an RA-TLS connection to the guest's attestation port (8443),
verifies the guest's report against AMD, and only then sends the passphrase.
A browser cannot open a raw TCP/TLS connection, so its TLS records travel over
a WebSocket to an **attest relay**, which writes them to the guest and back.

The relay sees TLS records only. It can drop a connection, but it cannot read
or change one: the TLS session runs between the browser's WASM and the guest,
and the browser checks that the guest's key is the one its AMD-signed report
commits to.

## There is no default relay

`confidentialStart.relayUrl` has no default. A site that offers confidential
starts names its own relay, usually the `/attest` route of an orbitdb-relay it
runs. No central service sits in every confidential start, and none can block
them all.

## In every orbitdb-relay

The orbitdb-relay image carries the attest relay. `attest-relay.service`
listens on `127.0.0.1:8787` only, and the relay's Caddy proxies
`wss://<relay host>/attest` to it. A relay deployed with a proxy hostname
therefore serves confidential starts too:

```jsx
<SponsorRelayFab
  confidential
  confidentialStart={{
    rootfsItemHash: '…',
    relayUrl: 'wss://<your relay host>/attest',
    loadWasm,
  }}
/>
```

Images built before this change have no `/attest` route; rebuild the image
(the reusable workflow does this per version).

## On its own

`packages/attest-relay` also runs on its own, on any host with Node 18+:

```bash
pnpm --filter @le-space/attest-relay bundle
ATTEST_RELAY_HOST=127.0.0.1 ATTEST_RELAY_TRUST_PROXY=1 node packages/attest-relay/dist/attest-relay.cjs
```

Then put TLS in front of it, for example with Caddy:

```
attest.example.com {
  handle /attest {
    reverse_proxy 127.0.0.1:8787
  }
}
```

`GET /health` answers on the relay's own port.

## What it will and will not do

- The client names a node and an instance (`/attest?crn=<node hash>&vm=<instance hash>`),
  never a host or a port. The relay looks up the node's address in Aleph's
  corechannel aggregate and the instance's networking in that node's
  executions list. It connects to the node's public IPv4 on the port mapped to
  8443, and if that fails, to the instance's own public IPv6 on 8443. A relay
  inside a VM needs the second: it cannot reach its own node's public IPv4.
  Private, loopback and link-local addresses are refused. It is not an open
  proxy.
- Each connection is limited in bytes (4 MiB per direction) and time
  (120 s). Connections are capped per client (4) and in total (256).
- Behind a proxy on the same host (`ATTEST_RELAY_TRUST_PROXY=1`), clients are
  counted by the address the proxy appends to `X-Forwarded-For`, and only
  when the connection comes from loopback.
- It contacts Aleph's API (`ALEPH_API_HOST`, default `https://api2.aleph.im`),
  the node named in the request, and the guest's mapped port. It contacts nothing else.

| Variable | Default | |
| --- | --- | --- |
| `ATTEST_RELAY_HOST` | `0.0.0.0` (`127.0.0.1` in the image) | Listen address |
| `ATTEST_RELAY_PORT` | `8787` | Listen port |
| `ATTEST_RELAY_TRUST_PROXY` | off (on in the image) | Count clients by `X-Forwarded-For` from a loopback proxy |
| `ATTEST_RELAY_ORIGINS` | any | Comma-separated allowed `Origin` headers |
| `ATTEST_RELAY_MAX_BYTES` | `4194304` | Bytes per direction |
| `ATTEST_RELAY_MAX_SECONDS` | `120` | Seconds per connection |
| `ATTEST_RELAY_MAX_PER_CLIENT` | `4` | Open connections per client |
| `ATTEST_RELAY_MAX_TOTAL` | `256` | Open connections in total |
| `ALEPH_API_HOST` | `https://api2.aleph.im` | Aleph API for the corechannel lookup |

In the image, an operator overrides these in `/etc/default/attest-relay`.
