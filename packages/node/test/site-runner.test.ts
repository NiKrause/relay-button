import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { cidV0ToV1, computeStaticSiteDirectoryCid, parseLastJsonObject, runBootstrapEnvMode, runDomainLinkMode, runProbeMode, runSitePublishMode as runSitePublishModeCar, verifyBrowserTransportCerthashes } from "../src/site-runner.ts"

const TWO_FILE_SITE_CID = 'bafybeibijbzrkewear2lkoylctlf6v4atsukit4c36dsxpeq4ndj66gqzi'
const TWO_FILE_SITE_CID_V0 = 'QmR3u6JNpvpoGEKfepbKQ6QRpDma6kwbg1e6aa4yoW9gzM'
const ONE_FILE_SITE_CID = 'bafybeiab5vrtxat6w4pmynetb4g6x5iirj3dtpnz74pgdupansxehuh72m'

function runSitePublishMode(env: NodeJS.ProcessEnv) {
  return runSitePublishModeCar({ ...env, ALEPH_SITE_UPLOAD_DRIVER: 'gateway-relay' })
}

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

test('verifyBrowserTransportCerthashes requires uc-go-peer direct transports with certhashes', () => {
  const peerId = '12D3KooWPeer'
  const valid = verifyBrowserTransportCerthashes([
    `/ip4/203.0.113.10/udp/9095/quic-v1/webtransport/certhash/uEiWebTransport/p2p/${peerId}`,
    `/ip4/203.0.113.10/udp/9095/webrtc-direct/certhash/uEiWebRtc/p2p/${peerId}`,
  ], 'uc-go-peer')
  assert.equal(valid.ok, true)

  const invalid = verifyBrowserTransportCerthashes([
    `/ip4/203.0.113.10/udp/9095/quic-v1/webtransport/p2p/${peerId}`,
  ], 'uc-go-peer')
  assert.equal(invalid.ok, false)
  assert.equal(invalid.missingCerthash.length, 1)
  assert.match(invalid.errors.join(' '), /WebRTC Direct/)
  assert.match(invalid.errors.join(' '), /missing \/certhash\//)
})

test('runProbeMode fails before dialing invalid uc-go-peer browser transports', async () => {
  const { outputFile, summaryFile } = await createOutputEnv('site-probe-certhash-')
  let probeCalled = false
  await assert.rejects(
    runProbeMode({
      GITHUB_OUTPUT: outputFile,
      GITHUB_STEP_SUMMARY: summaryFile,
      ALEPH_RELAY_PROFILE: 'uc-go-peer',
      PROBE_MULTIADDRS_JSON: '[]',
      BROWSER_BOOTSTRAP_MULTIADDRS_JSON: JSON.stringify([
        '/ip4/203.0.113.10/udp/9095/quic-v1/webtransport/p2p/12D3KooWPeer',
      ]),
    }, {
      probe: async () => {
        probeCalled = true
        return []
      },
    }),
    /certhash verification failed/,
  )
  assert.equal(probeCalled, false)
  const outputs = await readFile(outputFile, 'utf8')
  assert.match(outputs, /certhash_verification_ok=false/)
})

test('runDomainLinkMode detaches and attaches the production domain', async () => {
  const { outputFile, summaryFile } = await createOutputEnv('site-domain-')
  const originalFetch = globalThis.fetch
  const requests: Array<Record<string, unknown>> = []
  globalThis.fetch = (async (input, init) => {
    if (String(input) === 'https://relay.example.com') {
      return new Response('<!doctype html><title>site</title>', {
        status: 200,
        headers: { 'x-ipfs-roots': ONE_FILE_SITE_CID },
      })
    }
    if (String(input) === 'https://api2.aleph.im/api/v0/messages/abcd1234') {
      return new Response(JSON.stringify({ status: 'processed' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (String(input) !== 'https://api2.aleph.im/api/v0/messages') {
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
      ALEPH_SITE_IPFS_CID_V0: ONE_FILE_SITE_CID,
    })
  } finally {
    globalThis.fetch = originalFetch
  }

  const outputs = await readFile(outputFile, 'utf8')
  assert.match(outputs, /domain=relay.example.com/)
  assert.match(outputs, /item_hash=abcd1234/)
  assert.match(outputs, /url=https:\/\/relay.example.com/)
  assert.match(outputs, /domain_message_hash=[a-f0-9]{64}/)
  assert.match(outputs, new RegExp(`domain_verified_cid=${ONE_FILE_SITE_CID}`))
  assert.match(outputs, /domain_verified=true/)
  assert.equal(requests.length, 1)
  const attachMessage = (((requests[0]?.message as Record<string, unknown>)?.item_content as string | undefined) ?? '')
  assert.match(attachMessage, /"relay\.example\.com":\{"message_id":"abcd1234","type":"ipfs","programType":"ipfs","options":\{"catch_all_path":"\/index\.html"\}\}/)
})

test('runDomainLinkMode falls back once and keeps the working Aleph API host', async () => {
  const { outputFile, summaryFile } = await createOutputEnv('site-domain-api-fallback-')
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (input) => {
    const url = String(input)
    calls.push(url)
    if (url === 'https://api.aleph.im/api/v0/messages') {
      return new Response(JSON.stringify({ publication_status: { status: 'error' } }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url === 'https://api2.aleph.im/api/v0/messages') {
      return new Response(JSON.stringify({ item_hash: `msg-${calls.length}`, message_status: 'processed' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url === 'https://api2.aleph.im/api/v0/messages/abcd1234') {
      return new Response(JSON.stringify({ status: 'processed' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error(`Unexpected fetch call: ${url}`)
  }) as typeof fetch

  try {
    await runDomainLinkMode({
      GITHUB_OUTPUT: outputFile,
      GITHUB_STEP_SUMMARY: summaryFile,
      ALEPH_PRIVATE_KEY: '0x59c6995e998f97a5a0044966f0945382d7d3a2ab6c4b71a0f5f5d5b6d7e8f901',
      ALEPH_SITE_DOMAIN: 'relay.example.com',
      ALEPH_SITE_ITEM_HASH: 'abcd1234',
      ALEPH_SITE_ALEPH_API_HOSTS: 'https://api.aleph.im, https://api2.aleph.im',
    })
  } finally {
    globalThis.fetch = originalFetch
  }

  const outputs = await readFile(outputFile, 'utf8')
  assert.match(outputs, /domain=relay.example.com/)
  assert.equal(calls.filter((url) => url === 'https://api.aleph.im/api/v0/messages/abcd1234').length, 1)
  assert.equal(calls.filter((url) => url === 'https://api.aleph.im/api/v0/messages').length, 0)
  assert.equal(calls.filter((url) => url === 'https://api2.aleph.im/api/v0/messages/abcd1234').length, 1)
  assert.equal(calls.filter((url) => url === 'https://api2.aleph.im/api/v0/messages').length, 1)
})

test('cidV0ToV1 converts dag-pb CIDv0 values to lowercase base32 CIDv1', () => {
  assert.equal(
    cidV0ToV1('QmdfTbBqBPQ7VNxZEYEj14VmRuZBkqFbiwReogJgS1zR1n'),
    'bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku'
  )
})

test('computeStaticSiteDirectoryCid is deterministic for nested ordered fixtures', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'site-cid-fixture-'))
  await mkdir(join(dir, 'assets'), { recursive: true })
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>blog</title>')
  await writeFile(join(dir, 'assets', 'app.js'), 'console.log("hello")')
  const first = await computeStaticSiteDirectoryCid(dir)
  const second = await computeStaticSiteDirectoryCid(dir)
  assert.deepEqual(first, second)
  assert.equal(first.cidV0, TWO_FILE_SITE_CID_V0)
  assert.equal(first.cidV1, TWO_FILE_SITE_CID)
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
      JSON.stringify({ Name: '', Hash: TWO_FILE_SITE_CID }),
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
  assert.equal(requestUrl, 'https://ipfs-2.aleph.im/api/v0/add?recursive=true&wrap-with-directory=true&cid-version=1&raw-leaves=true')
  assert.deepEqual(uploadedFileNames, ['assets/app.js', 'index.html'])
  assert.match(outputs, new RegExp(`ipfs_cid_v0=${TWO_FILE_SITE_CID_V0}`))
  assert.match(outputs, /cid_match=true/)
  assert.match(outputs, /ipfs_gateway=https:\/\/ipfs-2\.aleph\.im/)
  assert.match(outputs, /aleph_api_host=https:\/\/api2\.aleph\.im/)
  assert.match(outputs, /direct_gateway_verified=false/)
  assert.match(summary, /Locally computed CID v0:/)
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
      JSON.stringify({ Name: '', Hash: TWO_FILE_SITE_CID }),
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

test('runSitePublishMode rejects a CID mismatch before publishing a STORE', async () => {
  const { dir, outputFile, summaryFile } = await createOutputEnv('site-publish-mismatch-')
  const siteDir = join(dir, 'dist')
  await mkdir(siteDir, { recursive: true })
  await writeFile(join(siteDir, 'index.html'), '<!doctype html><title>blog</title>')
  const calls: string[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input) => {
    calls.push(String(input))
    return new Response(JSON.stringify({ Name: '', Hash: 'QmdfTbBqBPQ7VNxZEYEj14VmRuZBkqFbiwReogJgS1zR1n' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  try {
    await assert.rejects(runSitePublishMode({
      GITHUB_OUTPUT: outputFile,
      GITHUB_STEP_SUMMARY: summaryFile,
      ALEPH_SITE_DIRECTORY: siteDir,
      ALEPH_SITE_PIN: 'true',
      ALEPH_PRIVATE_KEY: '0x59c6995e998f97a5a0044966f0945382d7d3a2ab6c4b71a0f5f5d5b6d7e8f901',
    }), /CID mismatch before STORE publication/)
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(calls.length, 1)
  assert.match(calls[0]!, /ipfs-2\.aleph\.im\/api\/v0\/add/)
})

test('runSitePublishMode uploads CAR and signed STORE metadata atomically by default', async () => {
  const { dir, outputFile, summaryFile } = await createOutputEnv('site-publish-car-')
  const siteDir = join(dir, 'dist')
  await mkdir(siteDir, { recursive: true })
  await writeFile(join(siteDir, 'index.html'), '<!doctype html><title>blog</title>')
  let storeHash = ''
  const calls: string[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    calls.push(url)
    if (url === 'https://api2.aleph.im/api/v0/ipfs/add_car') {
      assert.equal(init?.method, 'POST')
      assert.ok(init?.body instanceof FormData)
      const file = init.body.get('file')
      const metadata = init.body.get('metadata')
      assert.ok(file instanceof File)
      assert.equal(file.name, 'upload.car')
      assert.equal(file.type, 'application/vnd.ipld.car')
      assert.ok(file.size > 0)
      assert.ok(metadata instanceof Blob)
      const envelope = JSON.parse(await metadata.text()) as { sync?: boolean; message?: Record<string, unknown> }
      assert.equal(envelope.sync, true)
      const message = envelope.message ?? {}
      assert.equal(message.type, 'STORE')
      storeHash = String(message.item_hash ?? '')
      const content = JSON.parse(String(message.item_content ?? '{}')) as Record<string, unknown>
      assert.equal(content.item_hash, ONE_FILE_SITE_CID)
      assert.deepEqual(content.payment, { type: 'credit' })
      assert.equal('ref' in content, false)
      return new Response(JSON.stringify({ status: 'success', hash: ONE_FILE_SITE_CID, size: file.size }), { status: 200 })
    }
    if (url === `https://api2.aleph.im/api/v0/messages/${storeHash}`) {
      return new Response(JSON.stringify({ status: 'processed' }), { status: 200 })
    }
    if (url.includes('.ipfs.aleph.sh')) {
      return new Response('<!doctype html><title>blog</title>', { status: 200, headers: { 'x-ipfs-roots': ONE_FILE_SITE_CID } })
    }
    throw new Error(`Unexpected fetch call: ${url}`)
  }) as typeof fetch
  try {
    await runSitePublishModeCar({
      GITHUB_OUTPUT: outputFile,
      GITHUB_STEP_SUMMARY: summaryFile,
      ALEPH_SITE_DIRECTORY: siteDir,
      ALEPH_SITE_PIN: 'true',
      ALEPH_PRIVATE_KEY: '0x59c6995e998f97a5a0044966f0945382d7d3a2ab6c4b71a0f5f5d5b6d7e8f901',
    })
  } finally {
    globalThis.fetch = originalFetch
  }
  const outputs = await readFile(outputFile, 'utf8')
  assert.match(outputs, /site_upload_driver=authenticated-car/)
  assert.match(outputs, /store_processed=true/)
  assert.equal(calls.filter((url) => url.endsWith('/api/v0/ipfs/add_car')).length, 1)
  assert.equal(calls.filter((url) => url.endsWith('/api/v0/messages')).length, 0)
})

test('runSitePublishMode reuses the exact signed STORE envelope for transient retries', async () => {
  const { dir, outputFile, summaryFile } = await createOutputEnv('site-publish-idempotent-')
  const siteDir = join(dir, 'dist')
  await mkdir(siteDir, { recursive: true })
  await writeFile(join(siteDir, 'index.html'), '<!doctype html><title>blog</title>')
  const storeBodies: string[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    if (url.startsWith('https://ipfs-2.aleph.im/api/v0/add')) {
      return new Response(JSON.stringify({ Name: '', Hash: ONE_FILE_SITE_CID }), { status: 200 })
    }
    if (url === 'https://api2.aleph.im/api/v0/messages') {
      storeBodies.push(String(init?.body ?? ''))
      if (storeBodies.length < 3) return new Response('{}', { status: 503 })
      return new Response(JSON.stringify({ item_hash: 'stable-store' }), { status: 200 })
    }
    if (url === 'https://api2.aleph.im/api/v0/messages/stable-store') {
      return new Response(JSON.stringify({ status: 'processed' }), { status: 200 })
    }
    if (url.includes('.ipfs.aleph.sh')) {
      return new Response('<!doctype html><title>blog</title>', { status: 200, headers: { etag: ONE_FILE_SITE_CID } })
    }
    throw new Error(`Unexpected fetch call: ${url}`)
  }) as typeof fetch
  try {
    await runSitePublishMode({
      GITHUB_OUTPUT: outputFile,
      GITHUB_STEP_SUMMARY: summaryFile,
      ALEPH_SITE_DIRECTORY: siteDir,
      ALEPH_SITE_PIN: 'true',
      ALEPH_SITE_STORE_BROADCAST_ATTEMPTS: '3',
      ALEPH_PRIVATE_KEY: '0x59c6995e998f97a5a0044966f0945382d7d3a2ab6c4b71a0f5f5d5b6d7e8f901',
    })
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(storeBodies.length, 3)
  assert.equal(new Set(storeBodies).size, 1)
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
    if (String(input).includes('.ipfs.aleph.sh')) {
      return new Response('<!doctype html><title>blog</title>', { status: 200, headers: { 'x-ipfs-roots': ONE_FILE_SITE_CID } })
    }
    if (String(input).startsWith('https://ipfs-2.aleph.im/api/v0/add')) {
      return new Response(JSON.stringify({ Name: '', Hash: ONE_FILE_SITE_CID }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (String(input) === 'https://api2.aleph.im/api/v0/messages') {
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
      assert.equal(message.channel, 'ALEPH-CLOUDSOLUTIONS')
      assert.match(String(message.signature ?? body.signature ?? ''), /^0x[0-9a-fA-F]+$/)
      const itemContent = JSON.parse(String(message.item_content ?? '{}')) as {
        item_type?: string
        item_hash?: string
        address?: string
        payment?: { type?: string }
      }
      assert.equal(itemContent.item_type, 'ipfs')
      assert.equal(itemContent.item_hash, ONE_FILE_SITE_CID)
      assert.deepEqual(itemContent.payment, { type: 'credit' })
      assert.match(String(itemContent.address ?? ''), /^0x[0-9a-fA-F]{40}$/)
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
  assert.match(outputs, /direct_gateway_verified=true/)
  assert.equal(calls.filter((call) => call.url === 'https://api2.aleph.im/api/v0/messages').length, 1)
})

test('runSitePublishMode falls back to one Aleph API host and reuses it for wait', async () => {
  const { dir, outputFile, summaryFile } = await createOutputEnv('site-publish-api-fallback-')
  const siteDir = join(dir, 'dist')
  await mkdir(siteDir, { recursive: true })
  await writeFile(join(siteDir, 'index.html'), '<!doctype html><title>blog</title>')

  const originalFetch = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    calls.push(url)
    if (url.includes('.ipfs.aleph.sh')) {
      return new Response('<!doctype html><title>blog</title>', { status: 200, headers: { etag: ONE_FILE_SITE_CID } })
    }
    if (url.startsWith('https://ipfs-2.aleph.im/api/v0/add')) {
      return new Response(JSON.stringify({ Name: '', Hash: ONE_FILE_SITE_CID }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url === 'https://api.aleph.im/api/v0/messages') {
      assert.equal(init?.method, 'POST')
      return new Response(JSON.stringify({ publication_status: { status: 'error' } }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url === 'https://api2.aleph.im/api/v0/messages') {
      assert.equal(init?.method, 'POST')
      return new Response(JSON.stringify({ item_hash: 'store-api2' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url === 'https://api2.aleph.im/api/v0/messages/store-api2') {
      return new Response(JSON.stringify({ status: 'processed' }), {
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
      ALEPH_SITE_ENDPOINT_PAIRS: JSON.stringify([
        { ipfsGateway: 'https://ipfs-2.aleph.im', apiHost: 'https://api.aleph.im' },
        { ipfsGateway: 'https://ipfs-2.aleph.im', apiHost: 'https://api2.aleph.im' },
      ]),
    })
  } finally {
    globalThis.fetch = originalFetch
  }

  const outputs = await readFile(outputFile, 'utf8')
  assert.match(outputs, /item_hash=store-api2/)
  assert.equal(calls.filter((url) => url === 'https://api.aleph.im/api/v0/messages').length, 3)
  assert.equal(calls.filter((url) => url === 'https://api2.aleph.im/api/v0/messages').length, 1)
  assert.equal(calls.filter((url) => url === 'https://api2.aleph.im/api/v0/messages/store-api2').length, 1)
  assert.ok(!calls.some((url) => url.startsWith('https://api3.aleph.im/')))
})

test('runSitePublishMode rejects a pending STORE by default', async () => {
  const { dir, outputFile, summaryFile } = await createOutputEnv('site-publish-pending-')
  const siteDir = join(dir, 'dist')
  await mkdir(siteDir, { recursive: true })
  await writeFile(join(siteDir, 'index.html'), '<!doctype html><title>blog</title>')

  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    if (url.startsWith('https://ipfs-2.aleph.im/api/v0/add')) {
      return new Response(JSON.stringify({ Name: '', Hash: ONE_FILE_SITE_CID }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url === 'https://api2.aleph.im/api/v0/messages') {
      assert.equal(init?.method, 'POST')
      return new Response(JSON.stringify({ item_hash: 'store-pending' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url === 'https://api2.aleph.im/api/v0/messages/store-pending') {
      return new Response(JSON.stringify({ status: 'pending' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error(`Unexpected fetch call: ${url}`)
  }) as typeof fetch

  try {
    await assert.rejects(runSitePublishMode({
      GITHUB_OUTPUT: outputFile,
      GITHUB_STEP_SUMMARY: summaryFile,
      ALEPH_SITE_PROJECT_DIR: dir,
      ALEPH_SITE_DIRECTORY: siteDir,
      ALEPH_SITE_IPFS_GATEWAY: 'https://ipfs-2.aleph.im',
      ALEPH_PRIVATE_KEY: '0x59c6995e998f97a5a0044966f0945382d7d3a2ab6c4b71a0f5f5d5b6d7e8f901',
      ALEPH_SITE_PIN: 'true',
      ALEPH_SITE_ALEPH_MESSAGE_WAIT_ATTEMPTS: '1',
    }), /not safe to link a custom domain yet/)
  } finally {
    globalThis.fetch = originalFetch
  }

  const outputs = await readFile(outputFile, 'utf8')
  assert.match(outputs, /item_hash=store-pending/)
  assert.doesNotMatch(outputs, /store_processed=true/)
})

test('runDomainLinkMode refuses to link a pending STORE', async () => {
  const { outputFile, summaryFile } = await createOutputEnv('site-domain-pending-')
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input) => {
    if (String(input) === 'https://api2.aleph.im/api/v0/messages/pending-store') {
      return new Response(JSON.stringify({ status: 'pending' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error(`Unexpected fetch call: ${String(input)}`)
  }) as typeof fetch

  try {
    await assert.rejects(runDomainLinkMode({
      GITHUB_OUTPUT: outputFile,
      GITHUB_STEP_SUMMARY: summaryFile,
      ALEPH_PRIVATE_KEY: '0x59c6995e998f97a5a0044966f0945382d7d3a2ab6c4b71a0f5f5d5b6d7e8f901',
      ALEPH_SITE_DOMAIN: 'relay.example.com',
      ALEPH_SITE_ITEM_HASH: 'pending-store',
      ALEPH_SITE_ALEPH_MESSAGE_WAIT_ATTEMPTS: '1',
    }), /Custom domains may only target processed STORE messages/)
  } finally {
    globalThis.fetch = originalFetch
  }
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
    if (url.includes('.ipfs.aleph.sh')) {
      return new Response('<!doctype html><title>blog</title>', { status: 200, headers: { 'x-ipfs-roots': ONE_FILE_SITE_CID } })
    }
    if (url.startsWith('https://ipfs-2.aleph.im/api/v0/add')) {
      return new Response(JSON.stringify({ Name: '', Hash: ONE_FILE_SITE_CID }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url === 'https://api2.aleph.im/api/v0/messages' && init?.method === 'POST') {
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
    if (url === 'https://api2.aleph.im/api/v0/messages/store123') {
      return new Response(JSON.stringify({ status: 'processed' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url.startsWith('https://api2.aleph.im/api/v0/messages.json?')) {
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

  assert.equal(calls.filter((call) => call.url === 'https://api2.aleph.im/api/v0/messages').length, 2)
})

test('parseLastJsonObject parses multiline trailing JSON output', () => {
  const payload = parseLastJsonObject('prefix\n{\n  "item_hash": "abc123",\n  "content": {\n    "item_hash": "QmExample"\n  }\n}')
  assert.equal(payload.item_hash, 'abc123')
})
