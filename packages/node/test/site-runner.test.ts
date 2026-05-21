import test from "node:test"
import assert from "node:assert/strict"
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { cidV0ToV1, parseLastJsonObject, runBootstrapEnvMode, runDomainLinkMode, runProbeMode, runSitePublishMode } from "../src/site-runner.ts"

async function createOutputEnv(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  const outputFile = join(dir, 'output.txt')
  const summaryFile = join(dir, 'summary.txt')
  return { dir, outputFile, summaryFile }
}

test('runBootstrapEnvMode emits browser bootstrap outputs', async () => {
  const { outputFile, summaryFile } = await createOutputEnv('site-bootstrap-')
  await runBootstrapEnvMode({
    GITHUB_OUTPUT: outputFile,
    GITHUB_STEP_SUMMARY: summaryFile,
    BROWSER_BOOTSTRAP_MULTIADDRS_JSON: JSON.stringify(['/dns4/example.com/tcp/443/tls/ws/p2p/abc', ' /dns4/example.org/tcp/443/tls/ws/p2p/def ']),
  })

  const outputs = await readFile(outputFile, 'utf8')
  assert.match(outputs, /available=true/)
  assert.match(outputs, /count=2/)
  assert.match(outputs, /csv=\/dns4\/example.com\/tcp\/443\/tls\/ws\/p2p\/abc,\/dns4\/example.org\/tcp\/443\/tls\/ws\/p2p\/def/)
  assert.match(outputs, /json=\["\/dns4\/example.com/)
})

test('runProbeMode merges unique probe addresses and emits outputs', async () => {
  const { dir, outputFile, summaryFile } = await createOutputEnv('site-probe-')
  const scriptPath = join(dir, 'probe.mjs')
  await writeFile(scriptPath, [
    "const addrs = process.argv.slice(2)",
    "for (const addr of addrs) {",
    "  process.stdout.write(JSON.stringify({ address: addr, ok: true, protocols: [], dialMs: 1, pingMs: 1, remoteAddrs: [], error: null }) + '\\n')",
    "}",
    "",
  ].join('\n'))

  await runProbeMode({
    GITHUB_OUTPUT: outputFile,
    GITHUB_STEP_SUMMARY: summaryFile,
    ALEPH_SITE_PROBE_WORKDIR: dir,
    ALEPH_SITE_PROBE_SCRIPT: scriptPath,
    PROBE_MULTIADDRS_JSON: JSON.stringify(['/ip4/1.1.1.1/tcp/1234/p2p/peer', '/ip4/1.1.1.1/tcp/1234/p2p/peer']),
    BROWSER_BOOTSTRAP_MULTIADDRS_JSON: JSON.stringify(['/dns4/example.com/tcp/443/tls/ws/p2p/peer']),
  })

  const outputs = await readFile(outputFile, 'utf8')
  assert.match(outputs, /ok=true/)
  assert.match(outputs, /merged_multiaddrs_json=/)
  assert.match(outputs, /dns4\/example.com/)
})

test('runDomainLinkMode detaches and attaches the production domain', async () => {
  const { dir, outputFile, summaryFile } = await createOutputEnv('site-domain-')
  const fakeAleph = join(dir, 'aleph')
  const commandLog = join(dir, 'commands.log')
  await writeFile(fakeAleph, [
    '#!/bin/sh',
    'printf "%s\\n" "$*" >> "' + commandLog + '"',
    'exit 0',
    '',
  ].join('\n'))
  await chmod(fakeAleph, 0o755)

  await runDomainLinkMode({
    GITHUB_OUTPUT: outputFile,
    GITHUB_STEP_SUMMARY: summaryFile,
    ALEPH_SITE_PROJECT_DIR: dir,
    ALEPH_SITE_ALEPH_BIN: fakeAleph,
    ALEPH_SITE_DOMAIN: 'relay.example.com',
    ALEPH_SITE_ITEM_HASH: 'abcd1234',
  })

  const outputs = await readFile(outputFile, 'utf8')
  const commands = await readFile(commandLog, 'utf8')
  assert.match(outputs, /domain=relay.example.com/)
  assert.match(outputs, /item_hash=abcd1234/)
  assert.match(outputs, /url=https:\/\/relay.example.com/)
  assert.match(commands, /domain detach relay.example.com --no-ask/)
  assert.match(commands, /domain attach relay.example.com --item-hash abcd1234 --catch-all-path \/index.html --no-ask/)
})

test('cidV0ToV1 converts dag-pb CIDv0 values to lowercase base32 CIDv1', () => {
  assert.equal(
    cidV0ToV1('QmdfTbBqBPQ7VNxZEYEj14VmRuZBkqFbiwReogJgS1zR1n'),
    'bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku'
  )
})

test('runSitePublishMode uploads dist through the Node IPFS client and emits outputs', async () => {
  const { dir, outputFile, summaryFile } = await createOutputEnv('site-publish-')
  const siteDir = join(dir, 'dist')
  await mkdir(join(siteDir, 'assets'), { recursive: true })
  await writeFile(join(siteDir, 'index.html'), '<!doctype html><title>blog</title>')
  await writeFile(join(siteDir, 'assets', 'app.js'), 'console.log("hello")')

  const originalFetch = globalThis.fetch
  let requestUrl = ''
  let uploadedFileNames: string[] = []
  globalThis.fetch = (async (input, init) => {
    requestUrl = String(input)
    assert.equal(init?.method, 'POST')
    assert.ok(init?.body instanceof FormData)
    uploadedFileNames = Array.from(init.body.entries()).map(([, value]) => {
      assert.ok(value instanceof File)
      return value.name
    })
    return new Response([
      JSON.stringify({ Name: 'index.html', Hash: 'QmFileOne' }),
      JSON.stringify({ Name: '', Hash: 'QmdfTbBqBPQ7VNxZEYEj14VmRuZBkqFbiwReogJgS1zR1n' }),
    ].join('\n'), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch

  try {
    await runSitePublishMode({
      GITHUB_OUTPUT: outputFile,
      GITHUB_STEP_SUMMARY: summaryFile,
      ALEPH_SITE_PROJECT_DIR: dir,
      ALEPH_SITE_DIRECTORY: siteDir,
      ALEPH_SITE_IPFS_GATEWAY: 'https://ipfs-2.aleph.im',
      ALEPH_SITE_PIN: 'false',
    })
  } finally {
    globalThis.fetch = originalFetch
  }

  const outputs = await readFile(outputFile, 'utf8')
  const summary = await readFile(summaryFile, 'utf8')
  assert.equal(requestUrl, 'https://ipfs-2.aleph.im/api/v0/add?recursive=true&wrap-with-directory=true')
  assert.deepEqual(uploadedFileNames, ['assets/app.js', 'index.html'])
  assert.match(outputs, /ipfs_cid_v0=QmdfTbBqBPQ7VNxZEYEj14VmRuZBkqFbiwReogJgS1zR1n/)
  assert.match(outputs, /ipfs_cid_v1=bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku/)
  assert.match(outputs, /url=https:\/\/bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku\.ipfs\.aleph\.sh/)
  assert.match(summary, /IPFS CID v1: `bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku`/)
})

test('runSitePublishMode pins the CID through the direct Aleph REST API', async () => {
  const { dir, outputFile, summaryFile } = await createOutputEnv('site-publish-pin-')
  const siteDir = join(dir, 'dist')
  await mkdir(siteDir, { recursive: true })
  await writeFile(join(siteDir, 'index.html'), '<!doctype html><title>blog</title>')

  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = (async (input, init) => {
    calls.push({ url: String(input), init })
    if (String(input).startsWith('https://ipfs-2.aleph.im/api/v0/add')) {
      return new Response(JSON.stringify({ Name: '', Hash: 'QmdfTbBqBPQ7VNxZEYEj14VmRuZBkqFbiwReogJgS1zR1n' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (String(input) === 'https://api2.aleph.im/api/v0/ipfs/pin') {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        message?: { type?: string; content?: { hash?: string }; channel?: string }
        signature?: string
        address?: string
      }
      assert.equal(init?.method, 'POST')
      assert.equal(body.message?.type, 'IPFS_PIN')
      assert.equal(body.message?.content?.hash, 'QmdfTbBqBPQ7VNxZEYEj14VmRuZBkqFbiwReogJgS1zR1n')
      assert.equal(body.message?.channel, 'TEST')
      assert.match(String(body.signature ?? ''), /^0x[0-9a-fA-F]+$/)
      assert.match(String(body.address ?? ''), /^0x[0-9a-fA-F]{40}$/)
      return new Response(JSON.stringify({ item_hash: 'store123' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (String(input) === 'https://api2.aleph.im/api/v0/messages/store123') {
      return new Response(JSON.stringify({ status: 'processed' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error(`Unexpected fetch call: ${String(input)}`)
  }) as typeof fetch

  try {
    await runSitePublishMode({
      GITHUB_OUTPUT: outputFile,
      GITHUB_STEP_SUMMARY: summaryFile,
      ALEPH_SITE_PROJECT_DIR: dir,
      ALEPH_SITE_DIRECTORY: siteDir,
      ALEPH_SITE_IPFS_GATEWAY: 'https://ipfs-2.aleph.im',
      ALEPH_PRIVATE_KEY: '0x59c6995e998f97a5a0044966f0945382d7d3a2ab6c4b71a0f5f5d5b6d7e8f901',
      ALEPH_SITE_PIN: 'true',
    })
  } finally {
    globalThis.fetch = originalFetch
  }

  const outputs = await readFile(outputFile, 'utf8')
  assert.match(outputs, /item_hash=store123/)
  assert.equal(calls.filter((call) => call.url === 'https://api2.aleph.im/api/v0/ipfs/pin').length, 1)
})

test('parseLastJsonObject parses multiline trailing JSON output', () => {
  const payload = parseLastJsonObject('prefix\n{\n  "item_hash": "abc123",\n  "content": {\n    "item_hash": "QmExample"\n  }\n}')
  assert.equal(payload.item_hash, 'abc123')
})
