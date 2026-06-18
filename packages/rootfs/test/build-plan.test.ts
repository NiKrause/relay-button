import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import {
  createRootfsBuildPlan,
  deriveRootfsVersion,
  parseRootfsContract,
  referenceProfileContractPath,
  rootfsBuildShellEnv
} from '../src/index.ts'

test('deriveRootfsVersion prefers explicit version and otherwise uses git/date fallback', () => {
  assert.equal(deriveRootfsVersion({ rootfsVersion: 'custom-1.2.3' }), 'custom-1.2.3')
  assert.equal(
    deriveRootfsVersion({ gitShortSha: 'abc1234', now: new Date('2026-05-16T00:00:00Z') }),
    'uc-go-peer-git-20260516-abc1234'
  )
  assert.equal(deriveRootfsVersion({}), 'uc-go-peer-v0.1.0')
})

test('createRootfsBuildPlan resolves the same default paths the UC builder expects', async () => {
  const raw = await readFile(referenceProfileContractPath('uc-go-peer'), 'utf8')
  const contract = parseRootfsContract(raw)
  const plan = createRootfsBuildPlan(contract, {
    projectDir: '/workspace/universal-connectivity',
    gitShortSha: 'abc1234',
    now: new Date('2026-05-16T00:00:00Z')
  })

  assert.equal(plan.alephDir, '/workspace/universal-connectivity/go-peer/aleph')
  assert.equal(plan.outDir, '/workspace/universal-connectivity/go-peer/aleph/dist-rootfs')
  assert.equal(plan.contractPath, '/workspace/universal-connectivity/go-peer/aleph/root-profiles/uc-go-peer.json')
  assert.equal(plan.rootfsVersion, 'uc-go-peer-git-20260516-abc1234')
  assert.equal(plan.latestManifestPath, '/workspace/universal-connectivity/js-peer/public/rootfs/uc-go-peer/latest.json')
  assert.equal(plan.versionedManifestPath, '/workspace/universal-connectivity/js-peer/public/rootfs/uc-go-peer/uc-go-peer-git-20260516-abc1234.json')
  assert.equal(plan.imagePath, '/workspace/universal-connectivity/go-peer/aleph/dist-rootfs/aleph-uc-go-peer.qcow2')
  assert.equal(plan.binaryPath, '/workspace/universal-connectivity/go-peer/aleph/dist-rootfs/universal-chat-go')
})

test('rootfsBuildShellEnv emits UC-compatible builder variables', async () => {
  const raw = await readFile(referenceProfileContractPath('uc-go-peer'), 'utf8')
  const contract = parseRootfsContract(raw)
  const plan = createRootfsBuildPlan(contract, {
    projectDir: '/workspace/universal-connectivity',
    driver: 'docker',
    rootfsSizeMiB: 40960,
    rootfsImageSize: '40G',
    skipUpload: true,
    skipBuild: true,
    rootfsVersion: 'manual-v1'
  })

  const env = rootfsBuildShellEnv(plan)
  assert.equal(env.PROJECT_DIR, '/workspace/universal-connectivity')
  assert.equal(env.ROOTFS_BUILD_DRIVER, 'docker')
  assert.equal(env.ROOTFS_SIZE_MIB, '40960')
  assert.equal(env.ROOTFS_IMAGE_SIZE, '40G')
  assert.equal(env.ROOTFS_VERSION, 'manual-v1')
  assert.equal(env.SKIP_UPLOAD, '1')
  assert.equal(env.SKIP_BUILD, '1')
  assert.equal(env.ROOTFS_CONTRACT_FILE, '/workspace/universal-connectivity/go-peer/aleph/root-profiles/uc-go-peer.json')
  assert.equal(env.ALEPH_API_HOST, 'https://api.aleph.im')
  assert.equal(env.ALEPH_MESSAGE_WAIT_ATTEMPTS, '120')
  assert.equal(env.ALEPH_MESSAGE_WAIT_DELAY_SECONDS, '5')
})

test('createRootfsBuildPlan uses profile-aware defaults for orbitdb relay', async () => {
  const raw = await readFile(referenceProfileContractPath('orbitdb-relay'), 'utf8')
  const contract = parseRootfsContract(raw)
  const plan = createRootfsBuildPlan(contract, {
    projectDir: '/workspace/relay-deployer-pwa',
    orbitdbRelayDir: '/workspace/orbitdb-relay',
    gitShortSha: 'abc1234',
    now: new Date('2026-05-16T00:00:00Z')
  })

  assert.equal(plan.alephDir, '/workspace/relay-deployer-pwa')
  assert.equal(plan.outDir, '/workspace/relay-deployer-pwa/dist-rootfs')
  assert.equal(plan.rootfsVersion, 'orbitdb-relay-git-20260516-abc1234')
  assert.equal(plan.imagePath, '/workspace/relay-deployer-pwa/dist-rootfs/aleph-orbitdb-relay.qcow2')
  assert.equal(plan.latestManifestPath, '/workspace/relay-deployer-pwa/public/rootfs-manifest.json')
  assert.equal(plan.versionedManifestPath, '/workspace/relay-deployer-pwa/public/orbitdb-relay-git-20260516-abc1234.json')
  assert.equal(plan.orbitdbRelayDir, '/workspace/orbitdb-relay')

  const env = rootfsBuildShellEnv(plan)
  assert.equal(env.ORBITDB_RELAY_DIR, '/workspace/orbitdb-relay')
})

test('orbitdb relay image builder includes the JS contract helper runtime', async () => {
  const profileDir = referenceProfileContractPath('orbitdb-relay').replace(/contract\.json$/, 'rootfs')
  const script = await readFile(`${profileDir}/build-rootfs-image.sh`, 'utf8')
  const dockerfile = await readFile(`${profileDir}/Dockerfile.rootfs`, 'utf8')

  assert.match(script, /read-rootfs-contract\.mjs/)
  assert.doesNotMatch(script, /read-rootfs-contract\.py/)
  assert.match(dockerfile, /\bnodejs\b/)
})

test('reference rootfs builders run virt-sparsify with a workspace tmpdir and no prompt', async () => {
  for (const profile of ['orbitdb-relay', 'uc-go-peer']) {
    const profileDir = referenceProfileContractPath(profile).replace(/contract\.json$/, 'rootfs')
    const script = await readFile(`${profileDir}/build-rootfs-image.sh`, 'utf8')

    assert.match(script, /ROOTFS_SPARSIFY_TMPDIR=/)
    assert.match(script, /TMPDIR="\$\{ROOTFS_SPARSIFY_TMPDIR\}"/)
    assert.match(script, /--check-tmpdir=continue/)
  }
})

test('createRootfsBuildPlan uses profile-aware defaults for ucan-store', async () => {
  const raw = await readFile(referenceProfileContractPath('ucan-store'), 'utf8')
  const contract = parseRootfsContract(raw)
  const plan = createRootfsBuildPlan(contract, {
    projectDir: '/workspace/ucan-store',
    gitShortSha: 'abc1234',
    now: new Date('2026-05-16T00:00:00Z')
  })

  assert.equal(plan.alephDir, '/workspace/ucan-store')
  assert.equal(plan.outDir, '/workspace/ucan-store/dist-rootfs')
  assert.equal(plan.contractPath, '/workspace/ucan-store/root-profiles/ucan-store.json')
  assert.equal(plan.rootfsVersion, 'ucan-store-git-20260516-abc1234')
  assert.equal(plan.latestManifestPath, '/workspace/ucan-store/web/public/rootfs/ucan-store/latest.json')
  assert.equal(plan.versionedManifestPath, '/workspace/ucan-store/web/public/rootfs/ucan-store/ucan-store-git-20260516-abc1234.json')
  assert.equal(plan.imagePath, '/workspace/ucan-store/dist-rootfs/aleph-ucan-store.qcow2')
  assert.equal(plan.binaryPath, '/workspace/ucan-store/dist-rootfs/ucan-store')
})
