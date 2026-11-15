// The attest relay as a standalone service (relay-button#169, step 3):
//
//   ATTEST_RELAY_PORT=8787 ATTEST_RELAY_ORIGINS=https://example.com node src/server.ts
//
// GET /health answers 200; WebSocket upgrades on /attest?crn=…&vm=… are relayed.
// Put it behind TLS (wss://) in production, e.g. Caddy on the same host with
// ATTEST_RELAY_HOST=127.0.0.1 ATTEST_RELAY_TRUST_PROXY=1, so the per-client
// cap counts the visitors Caddy names in X-Forwarded-For, not Caddy itself.

import http from 'node:http'

import { attachAttestRelay, builderLimitsFor, resolveAttestationTarget } from './relay.ts'

const port = Number(process.env.ATTEST_RELAY_PORT ?? 8787)
const host = process.env.ATTEST_RELAY_HOST ?? '0.0.0.0'
const apiHost = process.env.ALEPH_API_HOST
const allowedOrigins = (process.env.ATTEST_RELAY_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter(Boolean)
// Image builders (paperless-anywhere#202) hand back a sealed image of about
// 900 MiB. With the default 4 MiB per connection that is some 290 connections,
// each attested anew. Workloads listed here (their dm-verity root hashes, from
// the builder's V-PROGRAM) get larger limits; any other VM keeps the defaults,
// so the relay stays no free tunnel to every VM on Aleph.
const builderRoothashes = new Set((process.env.ATTEST_RELAY_BUILDER_ROOTHASHES ?? '').split(',').map((h) => h.trim().toLowerCase()).filter((h) => /^[0-9a-f]{64}$/.test(h)))
const builderLimits = {
  maxBytes: Number(process.env.ATTEST_RELAY_BUILDER_MAX_BYTES ?? 256 * 1024 * 1024),
  maxSeconds: Number(process.env.ATTEST_RELAY_BUILDER_MAX_SECONDS ?? 600),
}

const server = http.createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: true, open: relay.open() }))
    return
  }
  response.writeHead(404)
  response.end()
})

const relay = attachAttestRelay(server, {
  resolveTarget: (crn, vm) => resolveAttestationTarget({ crn, vm, fetch: globalThis.fetch, apiHost }),
  allowedOrigins,
  maxBytes: Number(process.env.ATTEST_RELAY_MAX_BYTES ?? 4 * 1024 * 1024),
  maxSeconds: Number(process.env.ATTEST_RELAY_MAX_SECONDS ?? 120),
  maxPerClient: Number(process.env.ATTEST_RELAY_MAX_PER_CLIENT ?? 4),
  maxTotal: Number(process.env.ATTEST_RELAY_MAX_TOTAL ?? 256),
  limitsFor: builderRoothashes.size ? (_crn, vm) => builderLimitsFor(vm, { roothashes: builderRoothashes, limits: builderLimits, fetch: globalThis.fetch, apiHost }) : undefined,
  trustProxy: process.env.ATTEST_RELAY_TRUST_PROXY === '1',
  log: (message) => console.log(message),
})

server.listen(port, host, () => console.log(`[attest-relay] listening on ${host}:${port}`))
