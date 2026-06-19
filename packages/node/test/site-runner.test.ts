import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
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
  const { outputFile, summaryFile } = await createOutputEnv('site-probe-')
  await runProbeMode({
    GITHUB_OUTPUT: outputFile,
    GITHUB_STEP_SUMMARY: summaryFile,
    PROBE_MULTIADDRS_JSON: JSON.stringify(['/ip4/1.1.1.1/tcp/1234/p2p/peer', '/ip4/1.1.1.1/tcp/1234/p2p/peer']),
    BROWSER_BOOTSTRAP_MULTIADDRS_JSON: JSON.stringify(['/dns4/example.com/tcp/443/tls/ws/p2p/peer']),
  }, {
    probe: async (addrs) => addrs.map((addr) => ({
      address: addr,
      ok: true,
      protocols: [],
      family: 'tcp',
      required: true,
      dialMs: 1,
      pingMs: 1,
      remoteAddrs: [],
      error: null,
      warning: null,
    })),
  })

  const outputs = await readFile(outputFile, 'utf8')
  assert.match(outputs, /ok=true/)
  assert.match(outputs, /merged_multiaddrs_json=/)
  assert.match(outputs, /dns4\/example.com/)
})

test('runDomainLinkMode detaches and attaches the production domain', async () => {
  const { outputFile, summaryFile } = await createOutputEnv('site-domain-')
  const originalFetch = globalThis.fetch
  const requests: Array<Record<string, unknown>> = []
  globalThis.fetch = (async (input, init) => {
    if (String(input) !== 'https://api.aleph.im/api/v0/messages') {
      throw new Error(`Unexpected fetch call: ${String(input)}`)
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    requests.push(body)
    return new Response(JSON.stringify({ item_hash: `msg-${requests.length}`, message_status: 'processed' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch

  try {
    await runDomainLinkMode({
      GITHUB_OUTPUT: outputFile,
      GITHUB_STEP_SUMMARY: summaryFile,
      ALEPH_PRIVATE_KEY: '0x59c6995e998f97a5a0044966f0945382d7d3a2ab6c4b71a0f5f5d5b6d7e8f901',
      ALEPH_SITE_DOMAIN: 'relay.example.com',
      ALEPH_SITE_ITEM_HASH: 'abcd1234',
    })
  } finally {
    globalThis.fetch = originalFetch
  }

  const outputs = await readFile(outputFile, 'utf8')
  assert.match(outputs, /domain=relay.example.com/)
  assert.match(outputs, /item_hash=abcd1234/)
  assert.match(outputs, /url=https:\/\/relay.example.com/)
  assert.match(outputs, /domain_message_hash=[a-f0-9]{64}/)
  assert.equal(requests.length, 2)
  const detachMessage = (((requests[0]?.message as Record<string, unknown>)?.item_content as string | undefined) ?? '')
  const attachMessage = (((requests[1]?.message as Record<string, unknown>)?.item_content as string | undefined) ?? '')
  assert.match(detachMessage, /"relay\.example\.com":null/)
  assert.match(attachMessage, /"relay\.example\.com":\{"message_id":"abcd1234","type":"ipfs","programType":"ipfs","options":\{"catch_all_path":"\/index\.html"\}\}/)
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

test('runSitePublishMode resolves a relative site directory from ALEPH_SITE_PROJECT_DIR', async () => {
  const { dir, outputFile, summaryFile } = await createOutputEnv('site-publish-relative-')
  const projectDir = join(dir, 'project')
  const siteDir = join(projectDir, 'dist')
  await mkdir(join(siteDir, 'assets'), { recursive: true })
  await writeFile(join(siteDir, 'index.html'), '<!doctype html><title>blog</title>')
  await writeFile(join(siteDir, 'assets', 'app.js'), 'console.log("hello")')

  const originalFetch = globalThis.fetch
  let uploadedFileNames: string[] = []
  globalThis.fetch = (async (_input, init) => {
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
      ALEPH_SITE_PROJECT_DIR: projectDir,
      ALEPH_SITE_DIRECTORY: 'dist',
      ALEPH_SITE_PIN: 'false',
    })
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.deepEqual(uploadedFileNames, ['assets/app.js', 'index.html'])
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
    if (String(input) === 'https://api.aleph.im/api/v0/messages') {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        message?: {
          type?: string
          channel?: string
          item_content?: string
          signature?: string
        }
        signature?: string
      }
      const message = (body.message ?? {}) as {
        type?: string
        channel?: string
        item_content?: string
        signature?: string
      }
      assert.equal(init?.method, 'POST')
      assert.equal(message.type, 'STORE')
      assert.equal(message.channel, 'TEST')
      assert.match(String(message.signature ?? body.signature ?? ''), /^0x[0-9a-fA-F]+$/)
      const itemContent = JSON.parse(String(message.item_content ?? '{}')) as {
        item_type?: string
        item_hash?: string
        address?: string
      }
      assert.equal(itemContent.item_type, 'ipfs')
      assert.equal(itemContent.item_hash, 'QmdfTbBqBPQ7VNxZEYEj14VmRuZBkqFbiwReogJgS1zR1n')
      assert.match(String(itemContent.address ?? ''), /^0x[0-9a-fA-F]{40}$/)
      return new Response(JSON.stringify({ item_hash: 'store123' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (String(input) === 'https://api.aleph.im/api/v0/messages/store123') {
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
  assert.equal(calls.filter((call) => call.url === 'https://api.aleph.im/api/v0/messages').length, 1)
})

test('runSitePublishMode continues when accepted STORE message stays pending', async () => {
  const { dir, outputFile, summaryFile } = await createOutputEnv('site-publish-pending-')
  const siteDir = join(dir, 'dist')
  await mkdir(siteDir, { recursive: true })
  await writeFile(join(siteDir, 'index.html'), '<!doctype html><title>blog</title>')

  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    if (url.startsWith('https://ipfs-2.aleph.im/api/v0/add')) {
      return new Response(JSON.stringify({ Name: '', Hash: 'QmdfTbBqBPQ7VNxZEYEj14VmRuZBkqFbiwReogJgS1zR1n' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url === 'https://api.aleph.im/api/v0/messages') {
      assert.equal(init?.method, 'POST')
      return new Response(JSON.stringify({ item_hash: 'store-pending' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url === 'https://api.aleph.im/api/v0/messages/store-pending') {
      return new Response(JSON.stringify({ status: 'pending' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error(`Unexpected fetch call: ${url}`)
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
      ALEPH_SITE_ALEPH_MESSAGE_WAIT_ATTEMPTS: '1',
    })
  } finally {
    globalThis.fetch = originalFetch
  }

  const outputs = await readFile(outputFile, 'utf8')
  const summary = await readFile(summaryFile, 'utf8')
  assert.match(outputs, /item_hash=store-pending/)
  assert.match(summary, /Aleph item hash: `store-pending`/)
})

test('runSitePublishMode forgets older STORE messages for the same ALEPH_SITE_REF only', async () => {
  const { dir, outputFile, summaryFile } = await createOutputEnv('site-publish-retention-')
  const siteDir = join(dir, 'dist')
  await mkdir(siteDir, { recursive: true })
  await writeFile(join(siteDir, 'index.html'), '<!doctype html><title>blog</title>')

  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    calls.push({ url, init })
    if (url.startsWith('https://ipfs-2.aleph.im/api/v0/add')) {
      return new Response(JSON.stringify({ Name: '', Hash: 'QmdfTbBqBPQ7VNxZEYEj14VmRuZBkqFbiwReogJgS1zR1n' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url === 'https://api.aleph.im/api/v0/messages' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body ?? '{}')) as { message?: { type?: string; item_content?: string } }
      const message = body.message ?? {}
      if (message.type === 'STORE') {
        return new Response(JSON.stringify({ item_hash: 'store123' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (message.type === 'FORGET') {
        const itemContent = JSON.parse(String(message.item_content ?? '{}')) as { hashes?: string[] }
        assert.deepEqual(itemContent.hashes, ['old-2', 'old-3'])
        return new Response(JSON.stringify({ item_hash: 'forget123', message_status: 'processed' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
    }
    if (url === 'https://api.aleph.im/api/v0/messages/store123') {
      return new Response(JSON.stringify({ status: 'processed' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url.startsWith('https://api.aleph.im/api/v0/messages.json?')) {
      const parsedUrl = new URL(url)
      assert.equal(parsedUrl.searchParams.get('msgTypes'), 'STORE')
      assert.equal(parsedUrl.searchParams.get('pagination'), '100')
      return new Response(JSON.stringify({
        messages: [
          { item_hash: 'store123', time: 500, item_content: JSON.stringify({ item_type: 'ipfs', item_hash: 'QmCurrent', ref: 'orbit-blog-prod', time: 500 }) },
          { item_hash: 'old-1', time: 400, item_content: JSON.stringify({ item_type: 'ipfs', item_hash: 'QmOld1', ref: 'orbit-blog-prod', time: 400 }) },
          { item_hash: 'old-2', time: 300, item_content: JSON.stringify({ item_type: 'ipfs', item_hash: 'QmOld2', ref: 'orbit-blog-prod', time: 300 }) },
          { item_hash: 'other-app', time: 250, item_content: JSON.stringify({ item_type: 'ipfs', item_hash: 'QmOther', ref: 'uc-prod', time: 250 }) },
          { item_hash: 'old-3', time: 200, item_content: JSON.stringify({ item_type: 'ipfs', item_hash: 'QmOld3', ref: 'orbit-blog-prod', time: 200 }) },
        ],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error(`Unexpected fetch call: ${url}`)
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
      ALEPH_SITE_REF: 'orbit-blog-prod',
      ALEPH_SITE_RETENTION_KEEP_COUNT: '2',
    })
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.equal(calls.filter((call) => call.url === 'https://api.aleph.im/api/v0/messages').length, 2)
})

test('parseLastJsonObject parses multiline trailing JSON output', () => {
  const payload = parseLastJsonObject('prefix\n{\n  "item_hash": "abc123",\n  "content": {\n    "item_hash": "QmExample"\n  }\n}')
  assert.equal(payload.item_hash, 'abc123')
})
