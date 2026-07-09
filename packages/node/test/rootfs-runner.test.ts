import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { emitRootfsOutputs, parseRootfsRunnerInputs, runRootfsMode } from '../src/rootfs-runner.ts'

const rootfsContractPath = fileURLToPath(new URL('../../rootfs/reference/uc-go-peer/contract.json', import.meta.url))
const orbitdbRelayContractPath = fileURLToPath(
  new URL('../../rootfs/reference/orbitdb-relay/contract.json', import.meta.url),
)

async function createActionEnv(
  prefix: string,
  projectDir = '/workspace/universal-connectivity',
  contractPath = rootfsContractPath,
  referenceRootfsDir = '/workspace/relay-button/packages/rootfs/reference/uc-go-peer/rootfs',
) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  const outputFile = join(dir, 'output.txt')
  const summaryFile = join(dir, 'summary.txt')
  return {
    env: {
      GITHUB_OUTPUT: outputFile,
      GITHUB_STEP_SUMMARY: summaryFile,
      ALEPH_ROOTFS_PROJECT_DIR: projectDir,
      ALEPH_ROOTFS_CONTRACT_PATH: contractPath,
      ALEPH_ROOTFS_REFERENCE_ROOTFS_DIR: referenceRootfsDir,
    },
    outputFile,
    summaryFile,
  }
}

async function createFakeCommand(dir: string, name: string, body: string) {
  const target = join(dir, name)
  await writeFile(target, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return target
}

test('parseRootfsRunnerInputs creates a shared rootfs build plan from env', async () => {
  const { env } = await createActionEnv('shared-rootfs-plan-')
  const parsed = await parseRootfsRunnerInputs({
    ...env,
    ALEPH_ROOTFS_DRIVER: 'docker',
    ALEPH_ROOTFS_HAS_DOCKER: 'true',
    ALEPH_ROOTFS_DOCKER_DAEMON_RUNNING: 'true',
    ALEPH_ROOTFS_VERSION: 'uc-go-peer-git-20260516-deadbee',
  })

  assert.equal(parsed.buildPlan.driver, 'docker')
  assert.equal(parsed.buildPlan.rootfsVersion, 'uc-go-peer-git-20260516-deadbee')
  assert.equal(parsed.availability.hasDocker, true)
  assert.equal(parsed.referenceRootfsDir, '/workspace/relay-button/packages/rootfs/reference/uc-go-peer/rootfs')
})

test('parseRootfsRunnerInputs derives orbitdb relay rootfs versions from the caller package', async () => {
  const projectDir = await mkdtemp(join(tmpdir(), 'shared-orbitdb-relay-project-'))
  await mkdir(projectDir, { recursive: true })
  await writeFile(
    join(projectDir, 'package.json'),
    JSON.stringify({ name: 'orbitdb-relay', version: '0.9.2' }),
  )

  const { env } = await createActionEnv(
    'shared-rootfs-orbitdb-relay-',
    projectDir,
    orbitdbRelayContractPath,
    '/workspace/relay-button/packages/rootfs/reference/orbitdb-relay/rootfs',
  )
  const parsed = await parseRootfsRunnerInputs({
    ...env,
    ALEPH_ROOTFS_DRIVER: 'docker',
    ALEPH_ROOTFS_HAS_DOCKER: 'true',
    ALEPH_ROOTFS_DOCKER_DAEMON_RUNNING: 'true',
    ALEPH_ROOTFS_ORBITDB_RELAY_DIR: projectDir,
  })

  assert.equal(parsed.buildPlan.rootfsVersion, 'orbitdb-relay-v0.9.2')
  assert.equal(
    parsed.referenceRootfsDir,
    '/workspace/relay-button/packages/rootfs/reference/orbitdb-relay/rootfs',
  )
})

test('parseRootfsRunnerInputs auto-detects docker and virt-customize when env flags are omitted', async () => {
  const { env } = await createActionEnv('shared-rootfs-detect-')
  const binDir = await mkdtemp(join(tmpdir(), 'shared-rootfs-bin-'))
  await createFakeCommand(binDir, 'docker', 'if [ "$1" = "info" ]; then exit 0; fi\nexit 0')
  await createFakeCommand(binDir, 'virt-customize', 'exit 0')

  const parsed = await parseRootfsRunnerInputs({
    ...env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
  })

  assert.equal(parsed.availability.hasDocker, true)
  assert.equal(parsed.availability.dockerDaemonRunning, true)
  assert.equal(parsed.availability.hasVirtCustomize, true)
})

test('runRootfsMode emits the build plan in rootfs-build-plan mode', async () => {
  const { env } = await createActionEnv('shared-rootfs-build-plan-')
  const writes: string[] = []

  await runRootfsMode({
    ...env,
    ALEPH_VM_MODE: 'rootfs-build-plan',
    ALEPH_ROOTFS_VERSION: 'uc-go-peer-git-20260516-deadbee',
  }, {
    stdout: (text) => writes.push(text),
  })

  assert.match(writes.join(''), /uc-go-peer-git-20260516-deadbee/)
})

test('runRootfsMode executes rootfs-build through the shared build hook', async () => {
  const { env } = await createActionEnv('shared-rootfs-build-')
  const writes: string[] = []

  await runRootfsMode({
    ...env,
    ALEPH_VM_MODE: 'rootfs-build',
    ALEPH_ROOTFS_DRIVER: 'docker',
    ALEPH_ROOTFS_HAS_DOCKER: 'true',
    ALEPH_ROOTFS_DOCKER_DAEMON_RUNNING: 'true',
  }, {
    stdout: (text) => writes.push(text),
    buildRootfs: async (buildPlan) => ({
      pipeline: {
        buildPlan,
        executionPlan: {
          mode: 'docker',
          reason: 'test',
          referenceRootfsDir: '/workspace/relay-button/packages/rootfs/reference/uc-go-peer/rootfs',
          runCommand: { command: 'docker', args: ['run'] },
        },
        publicationArtifacts: {
          ipfsAddResponsePath: '/tmp/ipfs-add-response.jsonl',
          storeMessagePath: '/tmp/store-message.json',
          storeMessageStderrPath: '/tmp/store-message.stderr.log',
        },
        manifestPaths: { primaryPath: '/tmp/rootfs-manifest.json' },
      },
      executedCommands: [],
    }),
  })

  assert.match(writes.join(''), /"mode":"docker"/)
})

test('emitRootfsOutputs writes shared rootfs publish outputs', async () => {
  const { env, outputFile, summaryFile } = await createActionEnv('shared-rootfs-outputs-')

  await emitRootfsOutputs({
    pipeline: {
      buildPlan: {
        contract: { id: 'uc-go-peer' },
        contractPath: '/tmp/contract.json',
        projectDir: '/workspace/universal-connectivity',
        alephDir: '/workspace/universal-connectivity/go-peer/aleph',
        outDir: '/workspace/universal-connectivity/go-peer/aleph/dist-rootfs',
        driver: 'docker',
        rootfsSizeMiB: 20480,
        rootfsImageSize: '20G',
        rootfsVersion: 'uc-go-peer-git-20260516-deadbee',
        channel: 'ALEPH-CLOUDSOLUTIONS',
        skipUpload: false,
        skipBuild: false,
        ipfsAddUrl: 'https://ipfs.aleph.cloud/api/v0/add',
        ipfsGatewayUrl: 'https://ipfs.aleph.cloud/ipfs',
        alephApiHost: 'https://api.aleph.im',
        alephMessageWaitAttempts: 60,
        alephMessageWaitDelaySeconds: 5,
        alephPinAttempts: 4,
        alephPinDelaySeconds: 10,
        ipfsGatewayWaitAttempts: 30,
        ipfsGatewayWaitDelaySeconds: 10,
        manifestPath: '/workspace/universal-connectivity/go-peer/aleph/dist-rootfs/rootfs-manifest.json',
        latestManifestPath: '/workspace/universal-connectivity/js-peer/public/rootfs/uc-go-peer/latest.json',
        versionedManifestPath: '/workspace/universal-connectivity/js-peer/public/rootfs/uc-go-peer/uc-go-peer-git-20260516-deadbee.json',
        imagePath: '/workspace/universal-connectivity/go-peer/aleph/dist-rootfs/aleph-uc-go-peer.qcow2',
        baseImagePath: '/workspace/universal-connectivity/go-peer/aleph/dist-rootfs/debian-12-genericcloud-amd64.qcow2',
        binaryPath: '/workspace/universal-connectivity/go-peer/aleph/dist-rootfs/universal-chat-go',
      } as any,
      executionPlan: {
        mode: 'docker',
        reason: 'test',
        referenceRootfsDir: '/workspace/relay-button/packages/rootfs/reference/uc-go-peer/rootfs',
        runCommand: { command: 'docker', args: ['run'] },
      },
      publicationArtifacts: {
        ipfsAddResponsePath: '/tmp/ipfs-add-response.jsonl',
        storeMessagePath: '/tmp/store-message.json',
        storeMessageStderrPath: '/tmp/store-message.stderr.log',
      },
      manifestPaths: {
        primaryPath: '/workspace/universal-connectivity/go-peer/aleph/dist-rootfs/rootfs-manifest.json',
        copyTargetPath: '/workspace/universal-connectivity/js-peer/public/rootfs/uc-go-peer/latest.json',
        versionedTargetPath: '/workspace/universal-connectivity/js-peer/public/rootfs/uc-go-peer/uc-go-peer-git-20260516-deadbee.json',
      },
    },
    executedCommands: [],
    finalized: {
      manifest: {
        profile: 'uc-go-peer',
        version: 'uc-go-peer-git-20260516-deadbee',
        rootfsInstallStrategy: 'prebaked',
        requiresBootstrapNetwork: false,
        bootstrapSummary: 'Dependencies are preinstalled in the image.',
        requiredPortForwards: [],
        rootfsCid: 'bafyrootfs',
        rootfsItemHash: 'store-item-hash',
        rootfsSourceSizeBytes: 987654321,
        rootfsSizeMiB: 20480,
        createdAt: '2026-05-16T12:34:56Z',
        notes: 'note',
      },
      manifestJson: '{"version":"uc-go-peer-git-20260516-deadbee"}',
      manifestPaths: {
        primaryPath: '/workspace/universal-connectivity/go-peer/aleph/dist-rootfs/rootfs-manifest.json',
        copyTargetPath: '/workspace/universal-connectivity/js-peer/public/rootfs/uc-go-peer/latest.json',
        versionedTargetPath: '/workspace/universal-connectivity/js-peer/public/rootfs/uc-go-peer/uc-go-peer-git-20260516-deadbee.json',
      },
      publication: {
        cid: 'bafyrootfs',
        itemHash: 'store-item-hash',
        sourceSizeBytes: 987654321,
      },
    },
  } as any, env)

  const outputs = await readFile(outputFile, 'utf8')
  const summary = await readFile(summaryFile, 'utf8')
  assert.match(outputs, /rootfs_cid=bafyrootfs/)
  assert.match(outputs, /rootfs_item_hash=store-item-hash/)
  assert.match(summary, /Aleph Rootfs Runner/)
})

test('runRootfsMode executes rootfs-publish and emits outputs through the direct JS publish path', async () => {
  const projectDir = await mkdtemp(join(tmpdir(), 'shared-rootfs-project-'))
  const { env, outputFile } = await createActionEnv('shared-rootfs-publish-', projectDir)
  const writes: string[] = []
  const originalFetch = globalThis.fetch
  const calls: string[] = []

  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    calls.push(url)
    if (url === 'https://ipfs.aleph.cloud/ipfs/bafyrootfs') {
      assert.equal(init?.headers instanceof Headers ? init.headers.get('range') : (init?.headers as Record<string, string>)?.range, 'bytes=0-0')
      return new Response('', { status: 206 })
    }
    if (url === 'https://api.aleph.im/api/v0/messages') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { message?: { type?: string; item_content?: string; signature?: string } }
      const message = body.message ?? {}
      assert.equal(message.type, 'STORE')
      const itemContent = JSON.parse(String(message.item_content ?? '{}')) as { item_type?: string; item_hash?: string }
      assert.equal(itemContent.item_type, 'ipfs')
      assert.equal(itemContent.item_hash, 'bafyrootfs')
      return new Response(JSON.stringify({ item_hash: 'store-item-hash' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url === 'https://api.aleph.im/api/v0/messages/store-item-hash') {
      return new Response(JSON.stringify({ status: 'processed' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error(`Unexpected fetch call: ${url}`)
  }) as typeof fetch

  try {
    await runRootfsMode({
      ...env,
      ALEPH_VM_MODE: 'rootfs-publish',
      ALEPH_ROOTFS_VERSION: 'uc-go-peer-git-20260516-deadbee',
      ALEPH_ROOTFS_SKIP_UPLOAD: 'false',
      ALEPH_PRIVATE_KEY: '0x59c6995e998f97a5a0044966f0945382d7d3a2ab6c4b71a0f5f5d5b6d7e8f901',
    }, {
      stdout: (text) => writes.push(text),
      buildRootfs: async (buildPlan) => {
        await mkdir(join(projectDir, 'go-peer/aleph/dist-rootfs'), { recursive: true })
        await writeFile(buildPlan.imagePath, 'qcow2-binary')
        return {
          pipeline: {
            buildPlan,
            executionPlan: {
              mode: 'docker',
              reason: 'test',
              referenceRootfsDir: '/workspace/relay-button/packages/rootfs/reference/uc-go-peer/rootfs',
              runCommand: { command: '/bin/bash', args: ['build-rootfs.sh'] },
            },
            publicationArtifacts: {
              ipfsAddResponsePath: '/tmp/ipfs-add-response.jsonl',
              storeMessagePath: '/tmp/store-message.json',
              storeMessageStderrPath: '/tmp/store-message.stderr.log',
            },
            manifestPaths: {
              primaryPath: buildPlan.manifestPath,
              copyTargetPath: buildPlan.latestManifestPath ?? undefined,
              versionedTargetPath: buildPlan.versionedManifestPath ?? undefined,
            },
          },
          executedCommands: [],
        }
      },
      uploadRootfsImageToIpfs: async () => ({
        cid: 'bafyrootfs',
        responseText: JSON.stringify({
          Name: 'aleph-uc-go-peer.qcow2',
          Hash: 'bafyrootfs',
          Size: '987654321',
        }),
        sourceSizeBytes: 987654321,
      }),
    })
  } finally {
    globalThis.fetch = originalFetch
  }

  const outputs = await readFile(outputFile, 'utf8')
  assert.match(outputs, /rootfs_item_hash=store-item-hash/)
  assert.match(outputs, /rootfs_cid=bafyrootfs/)
  assert.ok(calls.includes('https://api.aleph.im/api/v0/messages'))
  assert.match(writes.join(''), /uc-go-peer-git-20260516-deadbee/)
})

test('runRootfsMode can build an artifact-ready rootfs while skipping Aleph IPFS upload', async () => {
  const projectDir = await mkdtemp(join(tmpdir(), 'shared-rootfs-artifact-only-project-'))
  const { env, outputFile, summaryFile } = await createActionEnv('shared-rootfs-artifact-only-', projectDir)
  const writes: string[] = []
  const imagePathSeen: string[] = []

  await runRootfsMode({
    ...env,
    ALEPH_VM_MODE: 'rootfs-publish',
    ALEPH_ROOTFS_VERSION: 'uc-go-peer-git-20260516-deadbee',
    ALEPH_ROOTFS_SKIP_UPLOAD: 'true',
  }, {
    stdout: (text) => writes.push(text),
    buildRootfs: async (buildPlan) => {
      await mkdir(join(projectDir, 'go-peer/aleph/dist-rootfs'), { recursive: true })
      await writeFile(buildPlan.imagePath, 'qcow2-binary')
      imagePathSeen.push(buildPlan.imagePath)
      return {
        pipeline: {
          buildPlan,
          executionPlan: {
            mode: 'docker',
            reason: 'test',
            referenceRootfsDir: '/workspace/relay-button/packages/rootfs/reference/uc-go-peer/rootfs',
            runCommand: { command: '/bin/bash', args: ['build-rootfs.sh'] },
          },
          publicationArtifacts: {
            ipfsAddResponsePath: '/tmp/ipfs-add-response.jsonl',
            storeMessagePath: '/tmp/store-message.json',
            storeMessageStderrPath: '/tmp/store-message.stderr.log',
          },
          manifestPaths: {
            primaryPath: buildPlan.manifestPath,
            copyTargetPath: buildPlan.latestManifestPath ?? undefined,
            versionedTargetPath: buildPlan.versionedManifestPath ?? undefined,
          },
        },
        executedCommands: [],
      }
    },
    uploadRootfsImageToIpfs: async () => {
      throw new Error('Aleph IPFS upload should be skipped')
    },
  })

  const outputs = await readFile(outputFile, 'utf8')
  const summary = await readFile(summaryFile, 'utf8')
  const stdout = writes.join('')

  assert.equal(imagePathSeen.length, 1)
  assert.match(outputs, /rootfs_version=uc-go-peer-git-20260516-deadbee/)
  assert.match(outputs, /rootfs_manifest_path=/)
  assert.match(outputs, /rootfs_image_path=/)
  assert.doesNotMatch(outputs, /rootfs_cid=/)
  assert.doesNotMatch(outputs, /rootfs_item_hash=/)
  assert.match(summary, /Published CID: ``/)
  assert.match(summary, /Aleph item hash: ``/)
  assert.match(stdout, /uc-go-peer-git-20260516-deadbee/)
})

test('runRootfsMode uploads rootfs through IPFS add endpoint and pins with credit payment', async () => {
  const projectDir = await mkdtemp(join(tmpdir(), 'shared-rootfs-aleph-ipfs-project-'))
  const { env, outputFile } = await createActionEnv('shared-rootfs-aleph-ipfs-', projectDir)
  const binDir = await mkdtemp(join(tmpdir(), 'shared-rootfs-aleph-ipfs-bin-'))
  const curlArgsPath = join(binDir, 'curl-args.txt')
  await createFakeCommand(
    binDir,
    'curl',
    'printf "%s\\n" "$@" > "$CURL_ARGS_FILE"\nprintf \'{"Name":"upload","Hash":"bafyrootfs","Size":"987654321"}\\n\'',
  )

  const originalFetch = globalThis.fetch
  const calls: string[] = []

  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    calls.push(url)
    if (url === 'https://ipfs.aleph.cloud/ipfs/bafyrootfs') {
      return new Response('', { status: 206 })
    }
    if (url === 'https://api.aleph.im/api/v0/messages') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { message?: { item_content?: string } }
      const itemContent = JSON.parse(String(body.message?.item_content ?? '{}')) as {
        item_type?: string;
        item_hash?: string;
        payment?: { type?: string };
      }
      assert.equal(itemContent.item_type, 'ipfs')
      assert.equal(itemContent.item_hash, 'bafyrootfs')
      assert.equal(itemContent.payment?.type, 'credit')
      return new Response(JSON.stringify({ item_hash: 'store-item-hash' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url === 'https://api.aleph.im/api/v0/messages/store-item-hash') {
      return new Response(JSON.stringify({ status: 'processed' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error(`Unexpected fetch call: ${url}`)
  }) as typeof fetch

  try {
    await runRootfsMode({
      ...env,
      ALEPH_VM_MODE: 'rootfs-publish',
      ALEPH_ROOTFS_VERSION: 'uc-go-peer-git-20260516-deadbee',
      ALEPH_ROOTFS_SKIP_UPLOAD: 'false',
      ALEPH_ROOTFS_UPLOAD_DRIVER: 'aleph-ipfs',
      ALEPH_ROOTFS_ALEPH_API_HOSTS: 'https://api.aleph.im',
      ALEPH_ROOTFS_IPFS_ADD_URLS: 'https://ipfs-2.aleph.im/api/v0/add,https://ipfs.aleph.cloud/api/v0/add',
      ALEPH_PRIVATE_KEY: '0x59c6995e998f97a5a0044966f0945382d7d3a2ab6c4b71a0f5f5d5b6d7e8f901',
      CURL_ARGS_FILE: curlArgsPath,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
    }, {
      buildRootfs: async (buildPlan) => {
        await mkdir(join(projectDir, 'go-peer/aleph/dist-rootfs'), { recursive: true })
        await writeFile(buildPlan.imagePath, 'qcow2-binary')
        return {
          pipeline: {
            buildPlan,
            executionPlan: {
              mode: 'docker',
              reason: 'test',
              referenceRootfsDir: '/workspace/relay-button/packages/rootfs/reference/uc-go-peer/rootfs',
              runCommand: { command: '/bin/bash', args: ['build-rootfs.sh'] },
            },
            publicationArtifacts: {
              ipfsAddResponsePath: '/tmp/ipfs-add-response.jsonl',
              storeMessagePath: '/tmp/store-message.json',
              storeMessageStderrPath: '/tmp/store-message.stderr.log',
            },
            manifestPaths: {
              primaryPath: buildPlan.manifestPath,
              copyTargetPath: buildPlan.latestManifestPath ?? undefined,
              versionedTargetPath: buildPlan.versionedManifestPath ?? undefined,
            },
          },
          executedCommands: [],
        }
      },
    })
  } finally {
    globalThis.fetch = originalFetch
  }

  const outputs = await readFile(outputFile, 'utf8')
  const curlArgs = await readFile(curlArgsPath, 'utf8')
  assert.match(outputs, /rootfs_item_hash=store-item-hash/)
  assert.match(outputs, /rootfs_cid=bafyrootfs/)
  assert.match(curlArgs, /https:\/\/ipfs-2\.aleph\.im\/api\/v0\/add/)
  assert.ok(calls.includes('https://api.aleph.im/api/v0/messages'))
})

test('runRootfsMode uploads rootfs through authenticated Aleph IPFS API with STORE metadata', async () => {
  const projectDir = await mkdtemp(join(tmpdir(), 'shared-rootfs-auth-ipfs-project-'))
  const { env, outputFile } = await createActionEnv('shared-rootfs-auth-ipfs-', projectDir)
  const binDir = await mkdtemp(join(tmpdir(), 'shared-rootfs-auth-ipfs-bin-'))
  const curlArgsPath = join(binDir, 'curl-args.txt')
  const expectedCid = 'QmcCd8B3y9bEhePjw8FwNuSwoTAXSbUjqkJZCgLuSNtSYn'
  await createFakeCommand(
    binDir,
    'curl',
    `printf "%s\\n" "$@" > "$CURL_ARGS_FILE"\nprintf '{"Hash":"${expectedCid}","Size":"11"}\\n'`,
  )

  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; method?: string }> = []

  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    calls.push({ url, method: init?.method })
    if (url.startsWith('https://api.aleph.im/api/v0/messages/')) {
      return new Response(JSON.stringify({ status: 'processed' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error(`Unexpected fetch call: ${url}`)
  }) as typeof fetch

  try {
    await runRootfsMode({
      ...env,
      ALEPH_VM_MODE: 'rootfs-publish',
      ALEPH_ROOTFS_VERSION: 'uc-go-peer-git-20260516-deadbee',
      ALEPH_ROOTFS_SKIP_UPLOAD: 'false',
      ALEPH_ROOTFS_UPLOAD_DRIVER: 'aleph-api-ipfs',
      ALEPH_ROOTFS_ALEPH_API_HOSTS: 'https://api.aleph.im',
      ALEPH_PRIVATE_KEY: '0x59c6995e998f97a5a0044966f0945382d7d3a2ab6c4b71a0f5f5d5b6d7e8f901',
      CURL_ARGS_FILE: curlArgsPath,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
    }, {
      buildRootfs: async (buildPlan) => {
        await mkdir(join(projectDir, 'go-peer/aleph/dist-rootfs'), { recursive: true })
        await writeFile(buildPlan.imagePath, 'qcow2-binary')
        return {
          pipeline: {
            buildPlan,
            executionPlan: {
              mode: 'docker',
              reason: 'test',
              referenceRootfsDir: '/workspace/relay-button/packages/rootfs/reference/uc-go-peer/rootfs',
              runCommand: { command: '/bin/bash', args: ['build-rootfs.sh'] },
            },
            publicationArtifacts: {
              ipfsAddResponsePath: '/tmp/ipfs-add-response.jsonl',
              storeMessagePath: '/tmp/store-message.json',
              storeMessageStderrPath: '/tmp/store-message.stderr.log',
            },
            manifestPaths: {
              primaryPath: buildPlan.manifestPath,
              copyTargetPath: buildPlan.latestManifestPath ?? undefined,
              versionedTargetPath: buildPlan.versionedManifestPath ?? undefined,
            },
          },
          executedCommands: [],
        }
      },
    })
  } finally {
    globalThis.fetch = originalFetch
  }

  const outputs = await readFile(outputFile, 'utf8')
  const curlArgs = await readFile(curlArgsPath, 'utf8')
  const itemHash = outputs.match(/^rootfs_item_hash=(.+)$/m)?.[1]
  assert.ok(itemHash)
  assert.match(outputs, new RegExp(`rootfs_cid=${expectedCid}`))
  assert.match(curlArgs, /https:\/\/api\.aleph\.im\/api\/v0\/ipfs\/add_file/)
  assert.match(curlArgs, /metadata=\{"message":/)
  assert.match(curlArgs, new RegExp(`\\\\?"item_hash\\\\?":\\\\?"${expectedCid}\\\\?"`))
  assert.match(curlArgs, /"sync":true/)
  assert.ok(calls.some((call) => call.url === `https://api.aleph.im/api/v0/messages/${itemHash}`))
  assert.equal(calls.some((call) => call.url === 'https://api.aleph.im/api/v0/messages' && call.method === 'POST'), false)
})

test('runRootfsMode retries transient Aleph message lookup failures during rootfs publish', async () => {
  const projectDir = await mkdtemp(join(tmpdir(), 'shared-rootfs-retry-project-'))
  const { env, outputFile } = await createActionEnv('shared-rootfs-retry-', projectDir)
  const originalFetch = globalThis.fetch
  let messageLookupCalls = 0

  globalThis.fetch = (async (input) => {
    const url = String(input)
    if (url === 'https://ipfs.aleph.cloud/ipfs/bafyrootfs') {
      return new Response('', { status: 206 })
    }
    if (url === 'https://api.aleph.im/api/v0/messages') {
      return new Response(JSON.stringify({ item_hash: 'store-item-hash' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url === 'https://api.aleph.im/api/v0/messages/store-item-hash') {
      messageLookupCalls += 1
      if (messageLookupCalls === 1) {
        return new Response('temporarily unavailable', { status: 503 })
      }
      return new Response(JSON.stringify({ status: 'processed' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error(`Unexpected fetch call: ${url}`)
  }) as typeof fetch

  try {
    await runRootfsMode({
      ...env,
      ALEPH_VM_MODE: 'rootfs-publish',
      ALEPH_ROOTFS_VERSION: 'uc-go-peer-git-20260516-deadbee',
      ALEPH_ROOTFS_SKIP_UPLOAD: 'false',
      ALEPH_PRIVATE_KEY: '0x59c6995e998f97a5a0044966f0945382d7d3a2ab6c4b71a0f5f5d5b6d7e8f901',
      ALEPH_ROOTFS_ALEPH_MESSAGE_WAIT_ATTEMPTS: '3',
      ALEPH_ROOTFS_ALEPH_MESSAGE_WAIT_DELAY_SECONDS: '0',
    }, {
      buildRootfs: async (buildPlan) => {
        await mkdir(join(projectDir, 'go-peer/aleph/dist-rootfs'), { recursive: true })
        await writeFile(buildPlan.imagePath, 'qcow2-binary')
        return {
          pipeline: {
            buildPlan,
            executionPlan: {
              mode: 'docker',
              reason: 'test',
              referenceRootfsDir: '/workspace/relay-button/packages/rootfs/reference/uc-go-peer/rootfs',
              runCommand: { command: '/bin/bash', args: ['build-rootfs.sh'] },
            },
            publicationArtifacts: {
              ipfsAddResponsePath: '/tmp/ipfs-add-response.jsonl',
              storeMessagePath: '/tmp/store-message.json',
              storeMessageStderrPath: '/tmp/store-message.stderr.log',
            },
            manifestPaths: {
              primaryPath: buildPlan.manifestPath,
              copyTargetPath: buildPlan.latestManifestPath ?? undefined,
              versionedTargetPath: buildPlan.versionedManifestPath ?? undefined,
            },
          },
          executedCommands: [],
        }
      },
      uploadRootfsImageToIpfs: async () => ({
        cid: 'bafyrootfs',
        responseText: JSON.stringify({
          Name: 'aleph-uc-go-peer.qcow2',
          Hash: 'bafyrootfs',
          Size: '987654321',
        }),
        sourceSizeBytes: 987654321,
      }),
    })
  } finally {
    globalThis.fetch = originalFetch
  }

  const outputs = await readFile(outputFile, 'utf8')
  assert.match(outputs, /rootfs_item_hash=store-item-hash/)
  assert.equal(messageLookupCalls, 2)
})

test('runRootfsMode falls back across Aleph API hosts when STORE broadcast is transiently unavailable', async () => {
  const projectDir = await mkdtemp(join(tmpdir(), 'shared-rootfs-api-fallback-project-'))
  const { env, outputFile } = await createActionEnv('shared-rootfs-api-fallback-', projectDir)
  const originalFetch = globalThis.fetch
  const calls: string[] = []

  globalThis.fetch = (async (input) => {
    const url = String(input)
    calls.push(url)
    if (url === 'https://ipfs.aleph.cloud/ipfs/bafyrootfs') {
      return new Response('', { status: 206 })
    }
    if (url === 'https://api.aleph.im/api/v0/messages') {
      return new Response(JSON.stringify({}), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url === 'https://api2.aleph.im/api/v0/messages') {
      return new Response(JSON.stringify({ item_hash: 'store-item-hash-api2' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url === 'https://api2.aleph.im/api/v0/messages/store-item-hash-api2') {
      return new Response(JSON.stringify({ status: 'processed' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error(`Unexpected fetch call: ${url}`)
  }) as typeof fetch

  try {
    await runRootfsMode({
      ...env,
      ALEPH_VM_MODE: 'rootfs-publish',
      ALEPH_ROOTFS_VERSION: 'uc-go-peer-git-20260516-deadbee',
      ALEPH_ROOTFS_SKIP_UPLOAD: 'false',
      ALEPH_PRIVATE_KEY: '0x59c6995e998f97a5a0044966f0945382d7d3a2ab6c4b71a0f5f5d5b6d7e8f901',
      ALEPH_ROOTFS_ALEPH_API_HOSTS: 'https://api.aleph.im, https://api2.aleph.im',
      ALEPH_ROOTFS_ALEPH_MESSAGE_WAIT_ATTEMPTS: '1',
    }, {
      buildRootfs: async (buildPlan) => {
        await mkdir(join(projectDir, 'go-peer/aleph/dist-rootfs'), { recursive: true })
        await writeFile(buildPlan.imagePath, 'qcow2-binary')
        return {
          pipeline: {
            buildPlan,
            executionPlan: {
              mode: 'docker',
              reason: 'test',
              referenceRootfsDir: '/workspace/relay-button/packages/rootfs/reference/uc-go-peer/rootfs',
              runCommand: { command: '/bin/bash', args: ['build-rootfs.sh'] },
            },
            publicationArtifacts: {
              ipfsAddResponsePath: '/tmp/ipfs-add-response.jsonl',
              storeMessagePath: '/tmp/store-message.json',
              storeMessageStderrPath: '/tmp/store-message.stderr.log',
            },
            manifestPaths: {
              primaryPath: buildPlan.manifestPath,
              copyTargetPath: buildPlan.latestManifestPath ?? undefined,
              versionedTargetPath: buildPlan.versionedManifestPath ?? undefined,
            },
          },
          executedCommands: [],
        }
      },
      uploadRootfsImageToIpfs: async () => ({
        cid: 'bafyrootfs',
        responseText: JSON.stringify({
          Name: 'aleph-uc-go-peer.qcow2',
          Hash: 'bafyrootfs',
          Size: '987654321',
        }),
        sourceSizeBytes: 987654321,
      }),
    })
  } finally {
    globalThis.fetch = originalFetch
  }

  const outputs = await readFile(outputFile, 'utf8')
  assert.match(outputs, /rootfs_item_hash=store-item-hash-api2/)
  assert.ok(calls.includes('https://api.aleph.im/api/v0/messages'))
  assert.ok(calls.includes('https://api2.aleph.im/api/v0/messages'))
  assert.ok(calls.includes('https://api2.aleph.im/api/v0/messages/store-item-hash-api2'))
})

test('runRootfsMode keeps accepted Aleph STORE hash when publish-only processing stays pending', async () => {
  const projectDir = await mkdtemp(join(tmpdir(), 'shared-rootfs-api-processing-fallback-project-'))
  const { env, outputFile } = await createActionEnv('shared-rootfs-api-processing-fallback-', projectDir)
  const originalFetch = globalThis.fetch
  const calls: string[] = []

  globalThis.fetch = (async (input) => {
    const url = String(input)
    calls.push(url)
    if (url === 'https://ipfs.aleph.cloud/ipfs/bafyrootfs') {
      return new Response('', { status: 206 })
    }
    if (url === 'https://api.aleph.im/api/v0/messages') {
      return new Response(JSON.stringify({ item_hash: 'store-item-hash-api1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url === 'https://api.aleph.im/api/v0/messages/store-item-hash-api1') {
      return new Response(JSON.stringify({ status: 'pending' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url === 'https://api2.aleph.im/api/v0/messages') {
      return new Response(JSON.stringify({ item_hash: 'store-item-hash-api2' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url === 'https://api2.aleph.im/api/v0/messages/store-item-hash-api2') {
      return new Response(JSON.stringify({ status: 'processed' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error(`Unexpected fetch call: ${url}`)
  }) as typeof fetch

  try {
    await runRootfsMode({
      ...env,
      ALEPH_VM_MODE: 'rootfs-publish',
      ALEPH_ROOTFS_VERSION: 'uc-go-peer-git-20260516-deadbee',
      ALEPH_ROOTFS_SKIP_UPLOAD: 'false',
      ALEPH_PRIVATE_KEY: '0x59c6995e998f97a5a0044966f0945382d7d3a2ab6c4b71a0f5f5d5b6d7e8f901',
      ALEPH_ROOTFS_ALEPH_API_HOSTS: 'https://api.aleph.im, https://api2.aleph.im',
      ALEPH_ROOTFS_ALEPH_MESSAGE_WAIT_ATTEMPTS: '1',
    }, {
      buildRootfs: async (buildPlan) => {
        await mkdir(join(projectDir, 'go-peer/aleph/dist-rootfs'), { recursive: true })
        await writeFile(buildPlan.imagePath, 'qcow2-binary')
        return {
          pipeline: {
            buildPlan,
            executionPlan: {
              mode: 'docker',
              reason: 'test',
              referenceRootfsDir: '/workspace/relay-button/packages/rootfs/reference/uc-go-peer/rootfs',
              runCommand: { command: '/bin/bash', args: ['build-rootfs.sh'] },
            },
            publicationArtifacts: {
              ipfsAddResponsePath: '/tmp/ipfs-add-response.jsonl',
              storeMessagePath: '/tmp/store-message.json',
              storeMessageStderrPath: '/tmp/store-message.stderr.log',
            },
            manifestPaths: {
              primaryPath: buildPlan.manifestPath,
              copyTargetPath: buildPlan.latestManifestPath ?? undefined,
              versionedTargetPath: buildPlan.versionedManifestPath ?? undefined,
            },
          },
          executedCommands: [],
        }
      },
      uploadRootfsImageToIpfs: async () => ({
        cid: 'bafyrootfs',
        responseText: JSON.stringify({
          Name: 'aleph-uc-go-peer.qcow2',
          Hash: 'bafyrootfs',
          Size: '987654321',
        }),
        sourceSizeBytes: 987654321,
      }),
    })
  } finally {
    globalThis.fetch = originalFetch
  }

  const outputs = await readFile(outputFile, 'utf8')
  assert.match(outputs, /rootfs_item_hash=store-item-hash-api1/)
  assert.match(outputs, /rootfs_cid=bafyrootfs/)
  assert.ok(calls.includes('https://api.aleph.im/api/v0/messages'))
  assert.ok(calls.includes('https://api.aleph.im/api/v0/messages/store-item-hash-api1'))
  assert.ok(!calls.includes('https://api2.aleph.im/api/v0/messages'))
})

test('runRootfsMode requires processed Aleph STORE hash when requested', async () => {
  const projectDir = await mkdtemp(join(tmpdir(), 'shared-rootfs-api-processing-required-project-'))
  const { env, outputFile } = await createActionEnv('shared-rootfs-api-processing-required-', projectDir)
  const originalFetch = globalThis.fetch
  const calls: string[] = []

  globalThis.fetch = (async (input) => {
    const url = String(input)
    calls.push(url)
    if (url === 'https://ipfs.aleph.cloud/ipfs/bafyrootfs') {
      return new Response('', { status: 206 })
    }
    if (url === 'https://api.aleph.im/api/v0/messages') {
      return new Response(JSON.stringify({ item_hash: 'store-item-hash-api1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url === 'https://api.aleph.im/api/v0/messages/store-item-hash-api1') {
      return new Response(JSON.stringify({ status: 'pending' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url === 'https://api2.aleph.im/api/v0/messages') {
      return new Response(JSON.stringify({ item_hash: 'store-item-hash-api2' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url === 'https://api2.aleph.im/api/v0/messages/store-item-hash-api2') {
      return new Response(JSON.stringify({ status: 'processed' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error(`Unexpected fetch call: ${url}`)
  }) as typeof fetch

  try {
    await runRootfsMode({
      ...env,
      ALEPH_VM_MODE: 'rootfs-publish',
      ALEPH_ROOTFS_VERSION: 'uc-go-peer-git-20260516-deadbee',
      ALEPH_ROOTFS_SKIP_UPLOAD: 'false',
      ALEPH_PRIVATE_KEY: '0x59c6995e998f97a5a0044966f0945382d7d3a2ab6c4b71a0f5f5d5b6d7e8f901',
      ALEPH_ROOTFS_ALEPH_API_HOSTS: 'https://api.aleph.im, https://api2.aleph.im',
      ALEPH_ROOTFS_ALEPH_MESSAGE_WAIT_ATTEMPTS: '1',
      ALEPH_ROOTFS_REQUIRE_PROCESSED_STORE: 'true',
    }, {
      buildRootfs: async (buildPlan) => {
        await mkdir(join(projectDir, 'go-peer/aleph/dist-rootfs'), { recursive: true })
        await writeFile(buildPlan.imagePath, 'qcow2-binary')
        return {
          pipeline: {
            buildPlan,
            executionPlan: {
              mode: 'docker',
              reason: 'test',
              referenceRootfsDir: '/workspace/relay-button/packages/rootfs/reference/uc-go-peer/rootfs',
              runCommand: { command: '/bin/bash', args: ['build-rootfs.sh'] },
            },
            publicationArtifacts: {
              ipfsAddResponsePath: '/tmp/ipfs-add-response.jsonl',
              storeMessagePath: '/tmp/store-message.json',
              storeMessageStderrPath: '/tmp/store-message.stderr.log',
            },
            manifestPaths: {
              primaryPath: buildPlan.manifestPath,
              copyTargetPath: buildPlan.latestManifestPath ?? undefined,
              versionedTargetPath: buildPlan.versionedManifestPath ?? undefined,
            },
          },
          executedCommands: [],
        }
      },
      uploadRootfsImageToIpfs: async () => ({
        cid: 'bafyrootfs',
        responseText: JSON.stringify({
          Name: 'aleph-uc-go-peer.qcow2',
          Hash: 'bafyrootfs',
          Size: '987654321',
        }),
        sourceSizeBytes: 987654321,
      }),
    })
  } finally {
    globalThis.fetch = originalFetch
  }

  const outputs = await readFile(outputFile, 'utf8')
  assert.match(outputs, /rootfs_item_hash=store-item-hash-api2/)
  assert.ok(calls.includes('https://api.aleph.im/api/v0/messages'))
  assert.ok(calls.includes('https://api.aleph.im/api/v0/messages/store-item-hash-api1'))
  assert.ok(calls.includes('https://api2.aleph.im/api/v0/messages'))
  assert.ok(calls.includes('https://api2.aleph.im/api/v0/messages/store-item-hash-api2'))
})

test('runRootfsMode does not fall back across Aleph API hosts when STORE is rejected', async () => {
  const projectDir = await mkdtemp(join(tmpdir(), 'shared-rootfs-api-rejected-project-'))
  const { env } = await createActionEnv('shared-rootfs-api-rejected-', projectDir)
  const originalFetch = globalThis.fetch
  const calls: string[] = []

  globalThis.fetch = (async (input) => {
    const url = String(input)
    calls.push(url)
    if (url === 'https://ipfs.aleph.cloud/ipfs/bafyrootfs') {
      return new Response('', { status: 206 })
    }
    if (url === 'https://api.aleph.im/api/v0/messages') {
      return new Response(JSON.stringify({ item_hash: 'store-item-hash-api1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url === 'https://api.aleph.im/api/v0/messages/store-item-hash-api1') {
      return new Response(JSON.stringify({
        status: 'rejected',
        details: {
          errors: [{
            account_balance: 0,
            required_balance: 208.333,
          }],
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error(`Unexpected fetch call: ${url}`)
  }) as typeof fetch

  try {
    await assert.rejects(
      runRootfsMode({
        ...env,
        ALEPH_VM_MODE: 'rootfs-publish',
        ALEPH_ROOTFS_VERSION: 'uc-go-peer-git-20260516-deadbee',
        ALEPH_ROOTFS_SKIP_UPLOAD: 'false',
        ALEPH_PRIVATE_KEY: '0x59c6995e998f97a5a0044966f0945382d7d3a2ab6c4b71a0f5f5d5b6d7e8f901',
        ALEPH_ROOTFS_ALEPH_API_HOSTS: 'https://api.aleph.im, https://api2.aleph.im',
        ALEPH_ROOTFS_ALEPH_MESSAGE_WAIT_ATTEMPTS: '1',
      }, {
        buildRootfs: async (buildPlan) => {
          await mkdir(join(projectDir, 'go-peer/aleph/dist-rootfs'), { recursive: true })
          await writeFile(buildPlan.imagePath, 'qcow2-binary')
          return {
            pipeline: {
              buildPlan,
              executionPlan: {
                mode: 'docker',
                reason: 'test',
                referenceRootfsDir: '/workspace/relay-button/packages/rootfs/reference/uc-go-peer/rootfs',
                runCommand: { command: '/bin/bash', args: ['build-rootfs.sh'] },
              },
              publicationArtifacts: {
                ipfsAddResponsePath: '/tmp/ipfs-add-response.jsonl',
                storeMessagePath: '/tmp/store-message.json',
                storeMessageStderrPath: '/tmp/store-message.stderr.log',
              },
              manifestPaths: {
                primaryPath: buildPlan.manifestPath,
                copyTargetPath: buildPlan.latestManifestPath ?? undefined,
                versionedTargetPath: buildPlan.versionedManifestPath ?? undefined,
              },
            },
            executedCommands: [],
          }
        },
        uploadRootfsImageToIpfs: async () => ({
          cid: 'bafyrootfs',
          responseText: JSON.stringify({
            Name: 'aleph-uc-go-peer.qcow2',
            Hash: 'bafyrootfs',
            Size: '987654321',
          }),
          sourceSizeBytes: 987654321,
        }),
      }),
      /insufficient Aleph balance: 0\.000 available, 208\.333 required, 208\.333 short/,
    )
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.ok(calls.includes('https://api.aleph.im/api/v0/messages'))
  assert.ok(calls.includes('https://api.aleph.im/api/v0/messages/store-item-hash-api1'))
  assert.ok(!calls.includes('https://api2.aleph.im/api/v0/messages'))
})
