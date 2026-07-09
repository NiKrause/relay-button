import test from "node:test";
import assert from "node:assert/strict";

import {
  createDockerRootfsBuildPipeline,
  createHostRootfsBuildPipeline,
  createRootfsBuildPipeline,
  createRootfsBuildPlan,
  finalizeRootfsBuildPipeline,
  readRootfsContractFile,
  referenceProfileContractPath,
} from "../src/index.ts";

async function loadPlan(driver: 'auto' | 'host' | 'docker' = 'auto') {
  const contract = await readRootfsContractFile(referenceProfileContractPath('uc-go-peer'));
  return createRootfsBuildPlan(contract, {
    projectDir: '/workspace/universal-connectivity',
    rootfsVersion: 'uc-go-peer-git-20260516-deadbee',
    driver,
  });
}

test('createRootfsBuildPipeline composes execution, publication, and manifest planning', async () => {
  const buildPlan = await loadPlan('auto');
  const pipeline = createRootfsBuildPipeline(buildPlan, {
    githubActions: true,
    hasDocker: true,
    dockerDaemonRunning: true,
    hasVirtCustomize: true,
  }, {
    referenceRootfsDir: '/workspace/relay-button/packages/rootfs/reference/uc-go-peer/rootfs',
  });

  assert.equal(pipeline.executionPlan.mode, 'docker');
  assert.deepEqual(pipeline.publicationArtifacts, {
    ipfsAddResponsePath: '/workspace/universal-connectivity/go-peer/aleph/dist-rootfs/ipfs-add-response.jsonl',
    storeMessagePath: '/workspace/universal-connectivity/go-peer/aleph/dist-rootfs/store-message.json',
    storeMessageStderrPath: '/workspace/universal-connectivity/go-peer/aleph/dist-rootfs/store-message.stderr.log',
  });
  assert.deepEqual(pipeline.manifestPaths, {
    primaryPath: '/workspace/universal-connectivity/go-peer/aleph/dist-rootfs/rootfs-manifest.json',
    copyTargetPath: '/workspace/universal-connectivity/js-peer/public/rootfs/uc-go-peer/latest.json',
    versionedTargetPath: '/workspace/universal-connectivity/js-peer/public/rootfs/uc-go-peer/uc-go-peer-git-20260516-deadbee.json',
  });
});

test('createHostRootfsBuildPipeline and createDockerRootfsBuildPipeline force the expected execution mode', async () => {
  const hostPlan = await loadPlan('host');
  const dockerPlan = await loadPlan('docker');

  assert.equal(
    createHostRootfsBuildPipeline(hostPlan, {
      referenceRootfsDir: '/workspace/relay-button/packages/rootfs/reference/uc-go-peer/rootfs',
    }).executionPlan.mode,
    'host',
  );
  assert.equal(
    createDockerRootfsBuildPipeline(dockerPlan, {
      referenceRootfsDir: '/workspace/relay-button/packages/rootfs/reference/uc-go-peer/rootfs',
    }).executionPlan.mode,
    'docker',
  );
});

test('finalizeRootfsBuildPipeline can derive manifest data directly from publish artifacts', async () => {
  const buildPlan = await loadPlan('auto');
  const finalized = finalizeRootfsBuildPipeline(buildPlan, {
    createdAt: '2026-05-16T12:34:56Z',
    ipfsAddResponseContent: [
      '{"Name":"chunk-a","Hash":"bafychunk","Size":"1024"}',
      '{"Name":"aleph-uc-go-peer.qcow2","Hash":"bafyrootfs","Size":"987654321"}',
    ].join('\n'),
    storeMessageContent: '{"item_hash":"store-item-hash"}',
  });

  assert.deepEqual(finalized.publication, {
    cid: 'bafyrootfs',
    itemHash: 'store-item-hash',
    sourceSizeBytes: 987654321,
  });
  assert.equal(finalized.manifest.rootfsCid, 'bafyrootfs');
  assert.equal(finalized.manifest.rootfsItemHash, 'store-item-hash');
  assert.equal(finalized.manifest.rootfsSourceSizeBytes, 987654321);
  assert.match(finalized.manifestJson, /"rootfsCid": "bafyrootfs"/u);
});

test('finalizeRootfsBuildPipeline also supports SKIP_UPLOAD-style manifest generation', async () => {
  const buildPlan = await loadPlan('auto');
  const finalized = finalizeRootfsBuildPipeline(buildPlan, {
    createdAt: '2026-05-16T12:34:56Z',
  });

  assert.equal(finalized.publication, undefined);
  assert.equal(finalized.manifest.rootfsCid, undefined);
  assert.equal(finalized.manifest.rootfsItemHash, undefined);
  assert.equal(finalized.manifest.createdAt, '2026-05-16T12:34:56Z');
});
