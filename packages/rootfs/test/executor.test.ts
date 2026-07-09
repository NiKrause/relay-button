import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRootfs,
  createRootfsBuildPlan,
  createRootfsScriptCommand,
  publishRootfs,
  readRootfsContractFile,
  referenceProfileContractPath,
} from "../src/index.ts";

async function loadPlan(driver: 'auto' | 'host' | 'docker' = 'auto', skipUpload = false) {
  const contract = await readRootfsContractFile(referenceProfileContractPath('uc-go-peer'));
  return createRootfsBuildPlan(contract, {
    projectDir: '/workspace/universal-connectivity',
    rootfsVersion: 'uc-go-peer-git-20260516-deadbee',
    driver,
    skipUpload,
  });
}

test('createRootfsScriptCommand runs the shared build-rootfs script with UC-compatible env', async () => {
  const plan = await loadPlan('auto');
  const command = createRootfsScriptCommand(plan, '/workspace/relay-button/packages/rootfs/reference/uc-go-peer/rootfs');

  assert.deepEqual(command, {
    command: '/bin/bash',
    args: ['/workspace/relay-button/packages/rootfs/reference/uc-go-peer/rootfs/build-rootfs.sh'],
    workdir: '/workspace/relay-button/packages/rootfs/reference/uc-go-peer/rootfs',
    env: {
      PROJECT_DIR: '/workspace/universal-connectivity',
      OUT_DIR: '/workspace/universal-connectivity/go-peer/aleph/dist-rootfs',
      ROOTFS_CONTRACT_FILE: '/workspace/universal-connectivity/go-peer/aleph/root-profiles/uc-go-peer.json',
      ROOTFS_BUILD_DRIVER: 'auto',
      ROOTFS_SIZE_MIB: '20480',
      ROOTFS_IMAGE_SIZE: '20G',
      ROOTFS_VERSION: 'uc-go-peer-git-20260516-deadbee',
      CHANNEL: 'ALEPH-CLOUDSOLUTIONS',
      SKIP_UPLOAD: '0',
      SKIP_BUILD: '0',
      IPFS_ADD_URL: 'https://ipfs.aleph.cloud/api/v0/add',
      IPFS_GATEWAY_URL: 'https://ipfs.aleph.cloud/ipfs',
      ALEPH_API_HOST: 'https://api.aleph.im',
      ALEPH_MESSAGE_WAIT_ATTEMPTS: '120',
      ALEPH_MESSAGE_WAIT_DELAY_SECONDS: '5',
      ALEPH_PIN_ATTEMPTS: '4',
      ALEPH_PIN_DELAY_SECONDS: '10',
      IPFS_GATEWAY_WAIT_ATTEMPTS: '30',
      IPFS_GATEWAY_WAIT_DELAY_SECONDS: '10',
    },
  });
});

test('buildRootfs executes prepare and run commands from the selected execution plan', async () => {
  const plan = await loadPlan('docker');
  const commands: Array<{ command: string; args: string[] }> = [];

  const result = await buildRootfs(
    plan,
    {
      async run(command) {
        commands.push({ command: command.command, args: command.args });
      },
    },
    {
      hasDocker: true,
      dockerDaemonRunning: true,
      hasVirtCustomize: false,
    },
    {
      referenceRootfsDir: '/workspace/relay-button/packages/rootfs/reference/uc-go-peer/rootfs',
    },
  );

  assert.equal(result.pipeline.executionPlan.mode, 'docker');
  assert.deepEqual(commands[0], {
    command: 'docker',
    args: [
      'build', '--platform', 'linux/amd64', '-t', 'uc-go-peer-rootfs-builder:local', '-f',
      '/workspace/relay-button/packages/rootfs/reference/uc-go-peer/rootfs/Dockerfile.rootfs',
      '/workspace/relay-button/packages/rootfs/reference/uc-go-peer/rootfs',
    ],
  });
  assert.equal(commands[1]?.command, 'docker');
  assert.ok(commands[1]?.args.includes('LIBGUESTFS_BACKEND=direct'));
  assert.ok(commands[1]?.args.includes('PROJECT_DIR=/workspace/project'));
  assert.ok(commands[1]?.args.includes('OUT_DIR=/workspace/project/go-peer/aleph/dist-rootfs'));
  assert.ok(commands[1]?.args.includes('ROOTFS_CONTRACT_FILE=/workspace/project/go-peer/aleph/root-profiles/uc-go-peer.json'));
  assert.ok(commands[1]?.args.includes('ROOTFS_IMAGE_SIZE=20G'));
  assert.ok(commands[1]?.args.includes('/workspace/universal-connectivity:/workspace/project'));
  assert.ok(commands[1]?.args.includes('/workspace/relay-button/packages/rootfs/reference/uc-go-peer/rootfs:/workspace/shared-rootfs'));
  assert.deepEqual(commands[1]?.args.slice(-3), [
    'uc-go-peer-rootfs-builder:local',
    '/bin/bash',
    '/workspace/shared-rootfs/build-rootfs-image.sh',
  ]);
});

test('publishRootfs runs the shared build-rootfs script and finalizes publish artifacts', async () => {
  const plan = await loadPlan('auto');
  const commands: string[] = [];

  const result = await publishRootfs(plan, {
    async run(command) {
      commands.push([command.command, ...command.args].join(' '));
    },
    async readText(targetPath) {
      if (targetPath.endsWith('ipfs-add-response.jsonl')) {
        return [
          '{"Name":"chunk-a","Hash":"bafychunk","Size":"1024"}',
          '{"Name":"aleph-uc-go-peer.qcow2","Hash":"bafyrootfs","Size":"987654321"}',
        ].join('\n');
      }
      if (targetPath.endsWith('store-message.json')) {
        return '{"item_hash":"store-item-hash"}';
      }
      throw new Error(`Unexpected read: ${targetPath}`);
    },
  }, {
    createdAt: '2026-05-16T12:34:56Z',
    referenceRootfsDir: '/workspace/relay-button/packages/rootfs/reference/uc-go-peer/rootfs',
  });

  assert.deepEqual(commands, [
    '/bin/bash /workspace/relay-button/packages/rootfs/reference/uc-go-peer/rootfs/build-rootfs.sh',
  ]);
  assert.equal(result.finalized.manifest.rootfsCid, 'bafyrootfs');
  assert.equal(result.finalized.manifest.rootfsItemHash, 'store-item-hash');
  assert.equal(result.finalized.manifest.rootfsSourceSizeBytes, 987654321);
});

test('publishRootfs supports skip-upload manifest generation without reading publish artifacts', async () => {
  const plan = await loadPlan('auto', true);
  let readCalls = 0;

  const result = await publishRootfs(plan, {
    async run() {},
    async readText() {
      readCalls += 1;
      return '';
    },
  }, {
    createdAt: '2026-05-16T12:34:56Z',
    referenceRootfsDir: '/workspace/relay-button/packages/rootfs/reference/uc-go-peer/rootfs',
  });

  assert.equal(readCalls, 0);
  assert.equal(result.finalized.manifest.rootfsCid, undefined);
  assert.equal(result.finalized.manifest.createdAt, '2026-05-16T12:34:56Z');
});
