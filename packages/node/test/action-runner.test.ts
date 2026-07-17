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
  const { env, outputFile, summaryFile } = await createActionEnv('relay-button-action-crn-')
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
  const { env, outputFile } = await createActionEnv('relay-button-action-crn-hook-')
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
  const { env, outputFile, summaryFile } = await createActionEnv('relay-button-action-deploy-')
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
  assert.match(summary, /Aleph Action Runner/)
  assert.match(writes.join(''), /instanceHash/)
})

test('runActionMode executes the shared deploy executor when required env is present', async () => {
  const { env, outputFile } = await createActionEnv('relay-button-action-live-deploy-')
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

test('runActionMode does not retry deploy mode across configured Aleph API hosts', async () => {
  const { env } = await createActionEnv('relay-button-action-api-hosts-')
  const attemptedHosts: string[] = []

  await assert.rejects(
    runActionMode(
      {
        ...env,
        ALEPH_VM_MODE: 'deploy',
        ALEPH_VM_PRIVATE_KEY: '0xabc',
        ALEPH_VM_NAME: 'uc-go-peer',
        ALEPH_VM_SSH_PUBLIC_KEY: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest key@example',
        ALEPH_VM_ROOTFS_ITEM_HASH: 'a'.repeat(64),
        ALEPH_VM_API_HOST: 'https://api2.aleph.im',
        ALEPH_VM_API_HOSTS: 'https://api2.aleph.im, https://api.aleph.im'
      },
      {
        deployExecutor: async (plan) => {
          attemptedHosts.push(plan.apiHost)
          throw new Error('api2 transient failure')
        }
      }
    ),
    /api2 transient failure/
  )

  assert.deepEqual(attemptedHosts, ['https://api2.aleph.im'])
})

test('runActionMode derives ucan-store bootstrap JSON before parsing the deploy plan', async () => {
  const { env, outputFile, summaryFile } = await createActionEnv('relay-button-action-ucan-derived-')

  await runActionMode(
    {
      ...env,
      ALEPH_VM_MODE: 'deploy',
      ALEPH_VM_PROFILE: 'ucan-store',
      ALEPH_VM_PRIVATE_KEY: '0xabc',
      ALEPH_VM_NAME: 'ucan-store',
      ALEPH_VM_SSH_PUBLIC_KEY: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest key@example',
      ALEPH_VM_ROOTFS_ITEM_HASH: 'c'.repeat(64),
      ALEPH_VM_UCAN_STORE_BOOTSTRAP_MODE: 'derive-from-aleph-private-key',
      ALEPH_VM_UCAN_STORE_SERVICE_DID: 'did:web:ucan-api.nicokrause.com',
      ALEPH_VM_UCAN_STORE_SERVICE_ORIGIN: 'https://ucan-api.nicokrause.com',
      ALEPH_VM_UCAN_STORE_PWA_ORIGIN: 'https://ucan.nicokrause.com'
    },
    {
      deriveUcanStoreBootstrapPackage: async () => ({
        operatorAddress: '0x1234000000000000000000000000000000000000',
        adminDid: 'did:key:zDerivedAdmin',
        serviceDid: 'did:web:ucan-api.nicokrause.com',
        spaceDid: 'did:key:zDerivedAdmin',
        rootDelegationProof: 'mZGVyaXZlZA==',
        allowedCapabilities: ['space/blob/add', 'upload/add'],
        defaultUserDelegationExpiration: 31536000,
        maxUserDelegationExpiration: 315360000,
        pwaOrigin: 'https://ucan.nicokrause.com',
        serviceOrigin: 'https://ucan-api.nicokrause.com'
      }),
      deployExecutor: async (plan) => {
        assert.equal(plan.adminDid, 'did:key:zDerivedAdmin')
        assert.deepEqual(plan.ucanStoreBootstrapPackage, {
          operatorAddress: '0x1234000000000000000000000000000000000000',
          adminDid: 'did:key:zDerivedAdmin',
          serviceDid: 'did:web:ucan-api.nicokrause.com',
          spaceDid: 'did:key:zDerivedAdmin',
          rootDelegationProof: 'mZGVyaXZlZA==',
          allowedCapabilities: ['space/blob/add', 'upload/add'],
          defaultUserDelegationExpiration: 31536000,
          maxUserDelegationExpiration: 315360000,
          pwaOrigin: 'https://ucan.nicokrause.com',
          serviceOrigin: 'https://ucan-api.nicokrause.com'
        })
        return {
          sender: '0x1234',
          itemHash: 'ucanDerivedHash',
          status: 'processed',
          verification: { ok: true },
          runtime: {
            diagnostics: {
              state: 'aleph-processed',
              timedOut: false,
              reason: 'Deployment message processed by Aleph.'
            }
          }
        }
      }
    }
  )

  const outputs = await readFile(outputFile, 'utf8')
  const summary = await readFile(summaryFile, 'utf8')
  assert.match(outputs, /ucan_store_bootstrap_admin_did=did:key:zDerivedAdmin/)
  assert.match(outputs, /ucan_store_bootstrap_space_did=did:key:zDerivedAdmin/)
  assert.match(outputs, /instance_item_hash=ucanDerivedHash/)
  assert.match(summary, /ucan-store Bootstrap/)
})

test('runActionMode emits retention outputs in retain-successful-deployments mode', async () => {
  const { env, outputFile, summaryFile } = await createActionEnv('relay-button-action-retention-')
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


test('runActionMode retries retention across configured Aleph API hosts', async () => {
  const { env, outputFile } = await createActionEnv('relay-button-action-retention-api-hosts-')
  const attemptedHosts: string[] = []

  await runActionMode(
    {
      ...env,
      ALEPH_VM_MODE: 'retain-successful-deployments',
      ALEPH_VM_PRIVATE_KEY: '0xabc',
      ALEPH_VM_API_HOST: 'https://api.aleph.im',
      ALEPH_VM_API_HOSTS: 'https://api.aleph.im, https://api2.aleph.im',
      ALEPH_VM_RETENTION_KEEP_COUNT: '2',
      ALEPH_VM_RETENTION_CURRENT_RECORD_JSON: JSON.stringify({
        instance_item_hash: 'instanceHash'
      }),
      ALEPH_VM_RETENTION_EXTRA_FORGET_HASHES_JSON: '[]'
    },
    {
      createPrivateKeyIdentity: async () => ({
        address: '0x1234',
        signer: async () => '0xsigned'
      }),
      retainSuccessfulDeployments: async (options) => {
        attemptedHosts.push(options.apiHost)
        if (options.apiHost === 'https://api.aleph.im') {
          throw new Error('primary API unavailable')
        }
        return {
          sender: options.sender,
          aggregateKey: 'uc-go-peer-successful-deployments',
          keepCount: 2,
          aggregatePublication: {
            itemHash: 'aggregateFallbackHash',
            status: 'processed'
          },
          retainedRecords: [{ instance_item_hash: 'instanceHash' }],
          prunedRecords: [],
          forgetHashes: [],
          forgottenHashes: [],
          outstandingForgetHashes: [],
          forgetResult: null
        }
      }
    }
  )

  const outputs = await readFile(outputFile, 'utf8')
  assert.deepEqual(attemptedHosts, [
    'https://api.aleph.im',
    'https://api2.aleph.im'
  ])
  assert.match(outputs, /retention_retained_count=1/)
})

test('runActionMode refreshes bootstrap registration from deployment metadata', async () => {
  const { env, outputFile, summaryFile } = await createActionEnv('relay-button-action-bootstrap-refresh-')
  const writes: string[] = []

  await runActionMode(
    {
      ...env,
      ALEPH_VM_MODE: 'refresh-bootstrap',
      ALEPH_VM_PRIVATE_KEY: '0xabc',
      ALEPH_VM_NAME: 'relay-demo',
      ALEPH_VM_PROFILE: 'uc-go-peer',
      ALEPH_VM_RELAY_PEER_ID: '12D3KooWRefresh',
      ALEPH_VM_PROBE_MULTIADDRS_JSON: JSON.stringify([
        '/dns4/relay.example.com/tcp/443/tls/ws/p2p/12D3KooWRefresh'
      ]),
      ALEPH_VM_BROWSER_BOOTSTRAP_MULTIADDRS_JSON: JSON.stringify([
        '/dns4/relay.example.com/tcp/443/tls/ws/p2p/12D3KooWRefresh'
      ]),
      ALEPH_VM_ROOTFS_VERSION: '0.3.0'
    },
    {
      stdout: (text) => writes.push(text),
      createPrivateKeyIdentity: async () => ({
        address: '0x1234',
        signer: async () => '0xsigned'
      }),
      publishRelayBootstrapRegistration: async (options) => {
        assert.equal(options.sender, '0x1234')
        assert.equal(options.peerId, '12D3KooWRefresh')
        assert.deepEqual(options.multiaddrs, [
          '/dns4/relay.example.com/tcp/443/tls/ws/p2p/12D3KooWRefresh'
        ])
        assert.equal(options.registrationId, 'relay:uc-go-peer:relay-demo')
        assert.equal(options.forgetPrevious, true)
        assert.equal(options.version, '0.3.0')
        return {
          status: 'published',
          itemHash: 'bootstrapHash',
          forgottenHashes: ['oldBootstrapHash']
        }
      }
    }
  )

  const outputs = await readFile(outputFile, 'utf8')
  const summary = await readFile(summaryFile, 'utf8')

  assert.match(outputs, /bootstrap_registration_item_hash=bootstrapHash/)
  assert.match(outputs, /bootstrap_registration_status=published/)
  assert.match(summary, /Aleph bootstrap refresh/)
  assert.match(summary, /Forgotten previous hashes: `1`/)
  assert.match(writes.join(''), /bootstrapHash/)
})


test('runActionMode retries bootstrap refresh across configured Aleph API hosts', async () => {
  const { env, outputFile } = await createActionEnv('relay-button-action-bootstrap-api-hosts-')
  const attemptedHosts: string[] = []

  await runActionMode(
    {
      ...env,
      ALEPH_VM_MODE: 'refresh-bootstrap',
      ALEPH_VM_PRIVATE_KEY: '0xabc',
      ALEPH_VM_NAME: 'relay-demo',
      ALEPH_VM_PROFILE: 'uc-go-peer',
      ALEPH_VM_API_HOST: 'https://api.aleph.im',
      ALEPH_VM_API_HOSTS: 'https://api.aleph.im, https://api2.aleph.im',
      ALEPH_VM_RELAY_PEER_ID: '12D3KooWRefreshFallback',
      ALEPH_VM_PROBE_MULTIADDRS_JSON: JSON.stringify([
        '/dns4/relay.example.com/tcp/443/tls/ws/p2p/12D3KooWRefreshFallback'
      ]),
      ALEPH_VM_BROWSER_BOOTSTRAP_MULTIADDRS_JSON: JSON.stringify([
        '/dns4/relay.example.com/tcp/443/tls/ws/p2p/12D3KooWRefreshFallback'
      ])
    },
    {
      createPrivateKeyIdentity: async () => ({
        address: '0x1234',
        signer: async () => '0xsigned'
      }),
      publishRelayBootstrapRegistration: async (options) => {
        attemptedHosts.push(options.apiHost)
        if (options.apiHost === 'https://api.aleph.im') {
          throw new Error('primary API unavailable')
        }
        return {
          status: 'published',
          itemHash: 'bootstrapFallbackHash',
          forgottenHashes: []
        }
      }
    }
  )

  const outputs = await readFile(outputFile, 'utf8')
  assert.deepEqual(attemptedHosts, [
    'https://api.aleph.im',
    'https://api2.aleph.im'
  ])
  assert.match(outputs, /bootstrap_registration_item_hash=bootstrapFallbackHash/)
})

test('runActionMode refresh-bootstrap can emit dual-key publication inputs', async () => {
  const { env } = await createActionEnv('relay-button-action-bootstrap-refresh-dual-')
  const seenKeys: string[] = []

  await runActionMode(
    {
      ...env,
      ALEPH_VM_MODE: 'refresh-bootstrap',
      ALEPH_VM_PRIVATE_KEY: '0xfallback',
      ALEPH_VM_PUBLISHER_PRIVATE_KEY: '0xpublisher',
      ALEPH_VM_OWNER_PRIVATE_KEY: '0xowner',
      ALEPH_VM_NAME: 'relay-demo',
      ALEPH_VM_PROFILE: 'orbitdb-relay',
      ALEPH_VM_RELAY_PEER_ID: '12D3KooWDual',
      ALEPH_VM_PROBE_MULTIADDRS_JSON: JSON.stringify([
        '/dns4/relay.example.com/tcp/443/tls/ws/p2p/12D3KooWDual'
      ]),
      ALEPH_VM_BROWSER_BOOTSTRAP_MULTIADDRS_JSON: JSON.stringify([
        '/dns4/relay.example.com/tcp/443/tls/ws/p2p/12D3KooWDual'
      ])
    },
    {
      createPrivateKeyIdentity: async (privateKey) => {
        seenKeys.push(privateKey)
        if (privateKey === '0xpublisher') {
          return {
            address: '0xpublisherAddress',
            signer: async () => '0xpublisherSigned'
          }
        }
        return {
          address: '0xownerAddress',
          signer: async () => '0xownerSigned'
        }
      },
      publishRelayBootstrapRegistration: async (options) => {
        assert.deepEqual(seenKeys, ['0xpublisher', '0xowner'])
        assert.equal(options.sender, '0xpublisherAddress')
        assert.equal(options.publisherAddress, '0xpublisherAddress')
        assert.equal(options.ownerAddress, '0xownerAddress')
        assert.equal(typeof options.ownerSigner, 'function')
        assert.equal(typeof options.publisherSigner, 'function')
        return {
          status: 'published',
          itemHash: 'dualBootstrapHash',
          forgottenHashes: []
        }
      }
    }
  )
})
