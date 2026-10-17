// Serves the test page and relays the guest's attestation port:
//
//   E2E_ROOTFS_ITEM_HASH=<encrypted STORE> node server.mjs
//
// GET /            the page (page.tsx, bundled on start)
// GET /config.json the manifest for the encrypted rootfs
// GET /pkg/*       the attestation WASM (web target)
// WS  /attest      the attest relay (packages/attest-relay)

import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as esbuild from 'esbuild'

import { attachAttestRelay, resolveAttestationTarget } from '../attest-relay/src/relay.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgDir = path.resolve(here, '../attest-wasm/pkg')
const port = Number(process.env.E2E_PORT ?? 4431)
const rootfsItemHash = process.env.E2E_ROOTFS_ITEM_HASH ?? ''
if (!/^[0-9a-f]{64}$/.test(rootfsItemHash)) throw new Error('set E2E_ROOTFS_ITEM_HASH to the encrypted rootfs STORE hash')

const contract = JSON.parse(await fs.readFile(path.resolve(here, '../rootfs/reference/orbitdb-relay/contract.json'), 'utf8'))
const config = {
  manifest: {
    profile: 'orbitdb-relay',
    version: process.env.E2E_ROOTFS_VERSION ?? 'confidential-e2e',
    supportsBootstrapConfigAggregate: true,
    rootfsItemHash,
    rootfsSizeMiB: Number(process.env.E2E_ROOTFS_SIZE_MIB ?? 20480),
    requiredPortForwards: contract.ports,
    createdAt: new Date().toISOString(),
  },
}

const bundle = await esbuild.build({
  entryPoints: [path.join(here, 'page.tsx')],
  bundle: true,
  write: false,
  format: 'esm',
  target: 'es2022',
  platform: 'browser',
  external: ['/pkg/*'],
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
})
const script = bundle.outputFiles[0].contents

const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Confidential start E2E</title></head>
<body><div id="root"></div><script type="module" src="/page.js"></script></body></html>`

const types = { '.js': 'text/javascript', '.wasm': 'application/wasm' }

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost')
  const send = (status, type, body) => {
    response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
    response.end(body)
  }
  if (url.pathname === '/') return send(200, 'text/html; charset=utf-8', page)
  if (url.pathname === '/page.js') return send(200, 'text/javascript', script)
  if (url.pathname === '/config.json') return send(200, 'application/json', JSON.stringify(config))
  if (url.pathname.startsWith('/pkg/')) {
    const name = path.basename(url.pathname)
    const type = types[path.extname(name)]
    if (!type) return send(404, 'text/plain', 'not found')
    const body = await fs.readFile(path.join(pkgDir, name)).catch(() => null)
    return body ? send(200, type, body) : send(404, 'text/plain', 'not found')
  }
  send(404, 'text/plain', 'not found')
})

attachAttestRelay(server, {
  resolveTarget: (crn, vm) => resolveAttestationTarget({ crn, vm, fetch: globalThis.fetch }),
  log: (message) => console.log(message),
})

server.listen(port, '127.0.0.1', () => console.log(`[e2e-confidential] http://127.0.0.1:${port}`))
