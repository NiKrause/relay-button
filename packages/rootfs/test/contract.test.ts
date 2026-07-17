import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import {
  contractShellEnv,
  parseRootfsContract,
  referenceProfileContractPath,
  referenceProfileRoot,
  referenceProfileRootfsDir,
  validateRootfsContract,
} from '../src/index.ts'

test('validateRootfsContract accepts the shared uc-go-peer reference contract', async () => {
  const raw = await readFile(referenceProfileContractPath('uc-go-peer'), 'utf8')
  const result = validateRootfsContract(JSON.parse(raw))
  assert.equal(result.valid, true)
  assert.equal(result.contract?.rootfs.binaryPath, '/usr/local/bin/universal-chat-go')
})

test('parseRootfsContract returns shell env values for the reference contract', async () => {
  const raw = await readFile(referenceProfileContractPath('uc-go-peer'), 'utf8')
  const contract = parseRootfsContract(raw)
  const env = contractShellEnv(contract, '/tmp/uc-go-peer.json')
  assert.equal(env.ROOTFS_CONTRACT_PROFILE, 'uc-go-peer')
  assert.equal(env.ROOTFS_CONTRACT_BINARY_PATH, '/usr/local/bin/universal-chat-go')
  assert.equal(env.ROOTFS_CONTRACT_INSTALL_DIR, '/opt/go-peer')
})

test('reference profile helpers resolve the copied uc-go-peer asset set', async () => {
  assert.match(referenceProfileRoot('uc-go-peer'), /reference\/uc-go-peer\/?$/)
  assert.match(referenceProfileContractPath('uc-go-peer'), /reference\/uc-go-peer\/contract\.json$/)
  assert.match(referenceProfileRootfsDir('uc-go-peer'), /reference\/uc-go-peer\/rootfs\/?$/)
})

test('validateRootfsContract accepts the shared ucan-store reference contract', async () => {
  const raw = await readFile(referenceProfileContractPath('ucan-store'), 'utf8')
  const result = validateRootfsContract(JSON.parse(raw))
  assert.equal(result.valid, true)
  assert.equal(result.contract?.rootfs.binaryPath, '/usr/local/bin/ucan-store')
  assert.deepEqual(result.contract?.ports, [
    { port: 22, tcp: true, udp: false, purpose: 'SSH' },
    {
      port: 80,
      tcp: true,
      udp: false,
      purpose: 'Temporary setup endpoint',
    },
    {
      port: 443,
      tcp: true,
      udp: false,
      purpose: 'HTTPS upload API, did:web discovery, revocation, and receipt proxy',
    },
  ])
})

test('reference profile helpers resolve the copied ucan-store asset set', async () => {
  assert.match(referenceProfileRoot('ucan-store'), /reference\/ucan-store\/?$/)
  assert.match(referenceProfileContractPath('ucan-store'), /reference\/ucan-store\/contract\.json$/)
  assert.match(referenceProfileRootfsDir('ucan-store'), /reference\/ucan-store\/rootfs\/?$/)
})

test('playwright-runner contract exposes only SSH and authenticated WSS', async () => {
  const raw = await readFile(referenceProfileContractPath('playwright-runner'), 'utf8')
  const result = validateRootfsContract(JSON.parse(raw))
  assert.equal(result.valid, true)
  assert.equal(result.contract?.rootfs.binaryPath, '/opt/playwright-runner/node_modules/.bin/playwright')
  assert.deepEqual(result.contract?.ports, [
    {
      port: 22,
      tcp: true,
      udp: false,
      purpose: 'SSH bootstrap and diagnostics',
    },
    {
      port: 443,
      tcp: true,
      udp: false,
      purpose: 'Authenticated Playwright WSS and version endpoint',
    },
  ])
})

test('playwright-runner reference includes auth, version, and TTL units', async () => {
  const root = referenceProfileRootfsDir('playwright-runner')
  const [caddy, bootstrap, timer, builder] = await Promise.all([
    readFile(new URL('Caddyfile', `file://${root}/`), 'utf8'),
    readFile(new URL('playwright-runner-bootstrap.sh', `file://${root}/`), 'utf8'),
    readFile(new URL('playwright-runner-ttl.timer', `file://${root}/`), 'utf8'),
    readFile(new URL('build-rootfs-image.sh', `file://${root}/`), 'utf8'),
  ])
  assert.match(caddy, /Authorization "Bearer \{\$PLAYWRIGHT_RUNNER_SECRET\}"/)
  assert.match(caddy, /admin off/)
  assert.match(caddy, /playwrightVersion/)
  assert.match(bootstrap, /PLAYWRIGHT_VERSION:-.*1\.61\.1/)
  assert.match(timer, /OnActiveSec=45min/)
  assert.match(builder, /playwright@\$\{PLAYWRIGHT_VERSION\}/)
  assert.match(builder, /playwright install --with-deps --only-shell chromium/)
  assert.doesNotMatch(builder, /PLAYWRIGHT_RUNNER_SECRET=/)
})

test('playwright-runner image installs only the Chromium headless shell and removes build caches', async () => {
  const root = referenceProfileRootfsDir('playwright-runner')
  const [buildScript, service] = await Promise.all([
    readFile(new URL('build-rootfs-image.sh', `file://${root}/`), 'utf8'),
    readFile(new URL('playwright-runner.service', `file://${root}/`), 'utf8'),
  ])

  assert.match(buildScript, /playwright install --with-deps --only-shell chromium/u)
  assert.match(buildScript, /PLAYWRIGHT_BROWSERS_PATH=\/opt\/playwright-browsers/u)
  assert.match(buildScript, /chown -R playwright-runner:playwright-runner \/opt\/playwright-runner \/opt\/playwright-browsers/u)
  assert.match(service, /Environment=PLAYWRIGHT_BROWSERS_PATH=\/opt\/playwright-browsers/u)
  assert.match(buildScript, /npm cache clean --force/u)
  assert.match(buildScript, /rm -rf \/var\/lib\/apt\/lists\/\*/u)
  assert.match(buildScript, /Compressed RootFS size:/u)
})

test('validateRootfsContract rejects malformed contracts', () => {
  const result = validateRootfsContract({
    schemaVersion: 1,
    id: 'broken',
    rootfs: {},
    services: {},
    ports: [],
    manifest: {},
  })
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((error) => error.includes('rootfs.profile')))
  assert.ok(result.errors.some((error) => error.includes('manifest.copyTarget')))
})
