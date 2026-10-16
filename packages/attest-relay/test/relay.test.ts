import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'

import { attachAttestRelay, isPublicIpv4, resolveAttestationTarget, type RelayOptions } from '../src/relay.ts'

const CRN = 'c'.repeat(64)
const VM = 'a'.repeat(64)

async function echoServer() {
  const server = net.createServer((socket) => socket.pipe(socket))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { port: (server.address() as AddressInfo).port, close: () => server.close() }
}

async function relay(options: Partial<RelayOptions> & Pick<RelayOptions, 'resolveTarget'>) {
  const server = http.createServer()
  const handle = attachAttestRelay(server, { allowPrivateTargets: true, ...options })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: (query: string) => `ws://127.0.0.1:${port}/attest?${query}`,
    handle,
    close: () => {
      handle.close()
      server.closeAllConnections()
      server.close()
    },
  }
}

function open(url: string, headers?: Record<string, string>) {
  const ws = new WebSocket(url, headers ? ({ headers } as unknown as string[]) : undefined)
  ws.binaryType = 'arraybuffer'
  return ws
}

const opened = (ws: WebSocket) =>
  new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener('error', () => reject(new Error('refused')), { once: true })
  })

const nextMessage = (ws: WebSocket) =>
  new Promise<Uint8Array>((resolve) => ws.addEventListener('message', (event) => resolve(new Uint8Array(event.data as ArrayBuffer)), { once: true }))

test('relays bytes both ways to the resolved target', async () => {
  const echo = await echoServer()
  const seen: string[] = []
  const r = await relay({ resolveTarget: async (crn, vm) => (seen.push(`${crn}/${vm}`), { host: '127.0.0.1', port: echo.port }) })
  const ws = open(r.url(`crn=${CRN}&vm=${VM}`))
  await opened(ws)
  const reply = nextMessage(ws)
  ws.send(new Uint8Array([0x16, 0x03, 0x01, 0x00]))
  assert.deepEqual(Array.from(await reply), [0x16, 0x03, 0x01, 0x00])
  assert.deepEqual(seen, [`${CRN}/${VM}`])
  ws.close()
  r.close()
  echo.close()
})

test('refuses anything but a node hash and an instance hash', async () => {
  const r = await relay({ resolveTarget: async () => assert.fail('must not resolve') })
  for (const query of [`crn=${CRN}`, `crn=${CRN}&vm=example.com:22`, `crn=../etc&vm=${VM}`, `host=10.0.0.1&port=22`]) {
    await assert.rejects(opened(open(r.url(query))), /refused/)
  }
  r.close()
})

test('refuses a non-public target unless told otherwise', async () => {
  const r = await relay({ allowPrivateTargets: false, resolveTarget: async () => ({ host: '127.0.0.1', port: 1 }) })
  await assert.rejects(opened(open(r.url(`crn=${CRN}&vm=${VM}`))), /refused/)
  assert.equal(r.handle.open(), 0, 'a refused connection is not counted')
  r.close()
})

test('closes a connection that exceeds the byte limit', async () => {
  const echo = await echoServer()
  const r = await relay({ maxBytes: 8, resolveTarget: async () => ({ host: '127.0.0.1', port: echo.port }) })
  const ws = open(r.url(`crn=${CRN}&vm=${VM}`))
  await opened(ws)
  const closed = new Promise<CloseEvent>((resolve) => ws.addEventListener('close', resolve, { once: true }))
  ws.send(new Uint8Array(16))
  assert.match((await closed).reason, /byte limit/)
  r.close()
  echo.close()
})

test('caps connections per client and honours an origin allowlist', async () => {
  const echo = await echoServer()
  const r = await relay({ maxPerClient: 1, allowedOrigins: ['https://app.example'], resolveTarget: async () => ({ host: '127.0.0.1', port: echo.port }) })
  await assert.rejects(opened(open(r.url(`crn=${CRN}&vm=${VM}`), { origin: 'https://evil.example' })), /refused/)
  const first = open(r.url(`crn=${CRN}&vm=${VM}`), { origin: 'https://app.example' })
  await opened(first)
  await assert.rejects(opened(open(r.url(`crn=${CRN}&vm=${VM}`), { origin: 'https://app.example' })), /refused/)
  first.close()
  r.close()
  echo.close()
})

test('resolveAttestationTarget finds the mapped 8443 of the instance on the node', async () => {
  const fetch = async (url: string) => {
    if (url.includes('/aggregates/')) {
      return { ok: true, status: 200, json: async () => ({ data: { corechannel: { resource_nodes: [{ hash: CRN, address: 'https://crn.example/' }] } } }) }
    }
    if (url === 'https://crn.example/v2/about/executions/list') {
      return { ok: true, status: 200, json: async () => ({ [VM]: { networking: { host_ipv4: '203.0.113.7', mapped_ports: { '8443': { host: 24651, tcp: true } } } } }) }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }
  assert.deepEqual(await resolveAttestationTarget({ crn: CRN, vm: VM, fetch }), { host: '203.0.113.7', port: 24651 })
  await assert.rejects(resolveAttestationTarget({ crn: CRN, vm: 'b'.repeat(64), fetch }), /no mapped attestation port/)
  await assert.rejects(resolveAttestationTarget({ crn: 'd'.repeat(64), vm: VM, fetch }), /no https address/)
})

test('isPublicIpv4 rejects loopback, private, link-local, CGNAT and reserved ranges', () => {
  for (const host of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'example.com']) {
    assert.equal(isPublicIpv4(host), false, host)
  }
  for (const host of ['65.108.233.158', '191.96.166.44', '172.32.0.1']) assert.equal(isPublicIpv4(host), true, host)
})
