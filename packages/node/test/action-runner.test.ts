import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildScaffoldDeployResult, runActionMode } from '../src/action-runner.ts'

async function createActionEnv(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  const outputFile = join(dir, 'output.txt')
  const summaryFile = join(dir, 'summary.txt')
  return {
    env: {
      GITHUB_OUTPUT: outputFile,
      GITHUB_STEP_SUMMARY: summaryFile,
      ALEPH_VM_PROFILE: 'uc-go-peer'
    },
    outputFile,
    summaryFile
  }
}

test('buildScaffoldDeployResult creates a minimal deploy-shaped payload from env', () => {
  const result = buildScaffoldDeployResult({
    ALEPH_VM_PROFILE: 'uc-go-peer',
    ALEPH_VM_INSTANCE_ITEM_HASH: 'instanceHash',
    ALEPH_VM_INSTANCE_STATUS: 'processed',
    ALEPH_VM_CRN_NAME: 'CRN One'
  })

  assert.equal(result.itemHash, 'instanceHash')
  assert.equal(result.status, 'processed')
  assert.equal(result.runtime.selectedCrn.name, 'CRN One')
})

test('runActionMode emits geocoded CRN outputs in list-crns mode', async () => {
  const { env, outputFile, summaryFile } = await createActionEnv('shared-aleph-action-crn-')
  const writes: string[] = []

  await runActionMode(
    {
      ...env,
      ALEPH_VM_MODE: 'list-crns',
      ALEPH_VM_GEOCRN_PAYLOAD_JSON: JSON.stringify([{ hash: 'a' }])
    },
    {
      stdout: (text) => writes.push(text)
    }
  )

  const outputs = await readFile(outputFile, 'utf8')
  const summary = await readFile(summaryFile, 'utf8')

  assert.match(outputs, /geocoded_crn_count=1/)
  assert.match(summary, /Geocoded CRNs/)
  assert.match(writes.join(''), /\[\{"hash":"a"\}\]/)
})

test('runActionMode can fetch geocoded CRNs through the shared core hook', async () => {
  const { env, outputFile } = await createActionEnv('shared-aleph-action-crn-hook-')
  const writes: string[] = []

  await runActionMode(
    {
      ...env,
      ALEPH_VM_MODE: 'list-crns',
      ALEPH_VM_CRN_LIST_URL: 'https://crns-list.aleph.sh/crns.json',
      ALEPH_VM_GEO_CRN_LIMIT: '12'
    },
    {
      stdout: (text) => writes.push(text),
      listGeocodedCrns: async (options) => {
        assert.equal(options.url, 'https://crns-list.aleph.sh/crns.json')
        assert.equal(options.limit, 12)
        return [{ hash: 'live-crn', country_code: 'DE' }]
      }
    }
  )

  const outputs = await readFile(outputFile, 'utf8')
  assert.match(outputs, /geocoded_crn_count=1/)
  assert.match(writes.join(''), /live-crn/)
})

test('runActionMode emits scaffold deploy outputs in deploy mode', async () => {
  const { env, outputFile, summaryFile } = await createActionEnv('shared-aleph-action-deploy-')
  const writes: string[] = []

  await runActionMode(
    {
      ...env,
      ALEPH_VM_MODE: 'deploy',
      ALEPH_VM_INSTANCE_ITEM_HASH: 'instanceHash',
      ALEPH_VM_INSTANCE_STATUS: 'processed'
    },
    {
      stdout: (text) => writes.push(text)
    }
  )

  const outputs = await readFile(outputFile, 'utf8')
  const summary = await readFile(summaryFile, 'utf8')

  assert.match(outputs, /instance_item_hash=instanceHash/)
  assert.match(outputs, /action_runner_mode=deploy/)
  assert.match(summary, /Shared Action Runner/)
  assert.match(writes.join(''), /instanceHash/)
})

test('runActionMode executes the shared deploy executor when required env is present', async () => {
  const { env, outputFile } = await createActionEnv('shared-aleph-action-live-deploy-')
  const writes: string[] = []

  await runActionMode(
    {
      ...env,
      ALEPH_VM_MODE: 'deploy',
      ALEPH_VM_PRIVATE_KEY: '0xabc',
      ALEPH_VM_NAME: 'uc-go-peer',
      ALEPH_VM_SSH_PUBLIC_KEY: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest key@example',
      ALEPH_VM_ROOTFS_ITEM_HASH: 'a'.repeat(64)
    },
    {
      stdout: (text) => writes.push(text),
      deployExecutor: async () => ({
        sender: '0x1234',
        itemHash: 'liveHash',
        status: 'processed',
        verification: { ok: true },
        runtime: {
          diagnostics: {
            state: 'aleph-processed',
            timedOut: false,
            reason: 'Deployment message processed by Aleph.'
          }
        }
      })
    }
  )

  const outputs = await readFile(outputFile, 'utf8')
  assert.match(outputs, /instance_item_hash=liveHash/)
  assert.match(writes.join(''), /liveHash/)
})

test('runActionMode emits retention outputs in retain-successful-deployments mode', async () => {
  const { env, outputFile, summaryFile } = await createActionEnv('shared-aleph-action-retention-')
  const writes: string[] = []

  await runActionMode(
    {
      ...env,
      ALEPH_VM_MODE: 'retain-successful-deployments',
      ALEPH_VM_PRIVATE_KEY: '0xabc',
      ALEPH_VM_RETENTION_KEEP_COUNT: '2',
      ALEPH_VM_RETENTION_CURRENT_RECORD_JSON: JSON.stringify({
        instance_item_hash: 'instanceHash',
        rootfs_item_hash: 'rootfsHash'
      }),
      ALEPH_VM_RETENTION_EXTRA_FORGET_HASHES_JSON: JSON.stringify(['siteHash'])
    },
    {
      stdout: (text) => writes.push(text),
      createPrivateKeyIdentity: async () => ({
        address: '0x1234',
        signer: async () => '0xsigned'
      }),
      retainSuccessfulDeployments: async (options) => {
        assert.equal(options.sender, '0x1234')
        assert.equal(options.keepCount, 2)
        assert.deepEqual(options.extraForgetHashes, ['siteHash'])
        return {
          sender: options.sender,
          aggregateKey: 'uc-go-peer-successful-deployments',
          keepCount: 2,
          aggregatePublication: {
            itemHash: 'aggregateHash',
            status: 'processed'
          },
          retainedRecords: [{ instance_item_hash: 'instanceHash' }],
          prunedRecords: [{ instance_item_hash: 'oldInstanceHash' }],
          forgetHashes: ['oldInstanceHash', 'siteHash'],
          forgottenHashes: ['oldInstanceHash'],
          outstandingForgetHashes: ['siteHash'],
          forgetResult: {
            itemHash: 'forgetHash',
            status: 'processed'
          }
        }
      }
    }
  )

  const outputs = await readFile(outputFile, 'utf8')
  const summary = await readFile(summaryFile, 'utf8')

  assert.match(outputs, /retention_pruned_count=1/)
  assert.match(outputs, /retention_retained_count=1/)
  assert.match(outputs, /retention_forget_hashes_json=\["oldInstanceHash","siteHash"\]/)
  assert.match(summary, /Successful deployment retention/)
  assert.match(summary, /Forgotten hashes: `1`/)
  assert.match(summary, /Outstanding forget hashes: `1`/)
  assert.match(writes.join(''), /aggregateHash/)
})
