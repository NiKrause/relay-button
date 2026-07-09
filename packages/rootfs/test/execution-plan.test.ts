import test from "node:test";
import assert from "node:assert/strict";

import {
  createDockerRootfsExecutionPlan,
  createHostRootfsExecutionPlan,
  createRootfsBuildPlan,
  parseRootfsContract,
  referenceProfileContractPath,
  selectRootfsExecutionPlan,
  readRootfsContractFile,
} from "../src/index.ts";

async function loadPlan(driver: 'auto' | 'host' | 'docker' = 'auto') {
  const contract = await readRootfsContractFile(referenceProfileContractPath('uc-go-peer'));
  return createRootfsBuildPlan(contract, {
    projectDir: '/workspace/universal-connectivity',
    rootfsVersion: 'uc-go-peer-git-20260516-deadbee',
    driver,
  });
}

test('createHostRootfsExecutionPlan runs the shared build script with UC-compatible env', async () => {
  const plan = await loadPlan('host');
  const execution = createHostRootfsExecutionPlan(plan, {
    referenceRootfsDir: '/workspace/relay-button/packages/rootfs/reference/uc-go-peer/rootfs',
  });

  assert.equal(execution.mode, 'host');
  assert.equal(execution.runCommand.command, '/bin/bash');
  assert.deepEqual(execution.runCommand.args, [
    '/workspace/relay-button/packages/rootfs/reference/uc-go-peer/rootfs/build-rootfs-image.sh',
  ]);
  assert.equal(execution.runCommand.env?.PROJECT_DIR, '/workspace/universal-connectivity');
  assert.equal(execution.runCommand.env?.ROOTFS_CONTRACT_FILE, '/workspace/universal-connectivity/go-peer/aleph/root-profiles/uc-go-peer.json');
});

test('createDockerRootfsExecutionPlan mirrors the current Dockerized rootfs build flow', async () => {
  const plan = await loadPlan('docker');
  const execution = createDockerRootfsExecutionPlan(plan, {
    referenceRootfsDir: '/workspace/relay-button/packages/rootfs/reference/uc-go-peer/rootfs',
  });

  assert.equal(execution.mode, 'docker');
  assert.deepEqual(execution.prepareCommand?.args, [
    'build',
    '--platform',
    'linux/amd64',
    '-t',
    'uc-go-peer-rootfs-builder:local',
    '-f',
    '/workspace/relay-button/packages/rootfs/reference/uc-go-peer/rootfs/Dockerfile.rootfs',
    '/workspace/relay-button/packages/rootfs/reference/uc-go-peer/rootfs',
  ]);
  assert.deepEqual(execution.runCommand.args.slice(0, 6), [
    'run',
    '--rm',
    '--privileged',
    '--platform',
    'linux/amd64',
    '-e',
  ]);
  assert.ok(execution.runCommand.args.includes('LIBGUESTFS_BACKEND=direct'));
  assert.ok(execution.runCommand.args.includes('PROJECT_DIR=/workspace/project'));
  assert.ok(execution.runCommand.args.includes('OUT_DIR=/workspace/project/go-peer/aleph/dist-rootfs'));
  assert.ok(execution.runCommand.args.includes('ROOTFS_CONTRACT_FILE=/workspace/project/go-peer/aleph/root-profiles/uc-go-peer.json'));
  assert.ok(execution.runCommand.args.includes('ROOTFS_IMAGE_SIZE=20G'));
  assert.ok(execution.runCommand.args.includes('/workspace/universal-connectivity:/workspace/project'));
  assert.ok(execution.runCommand.args.includes('/workspace/relay-button/packages/rootfs/reference/uc-go-peer/rootfs:/workspace/shared-rootfs'));
  assert.deepEqual(execution.runCommand.args.slice(-3), [
    'uc-go-peer-rootfs-builder:local',
    '/bin/bash',
    '/workspace/shared-rootfs/build-rootfs-image.sh',
  ]);
});

test('selectRootfsExecutionPlan prefers Docker on GitHub Actions for auto driver', async () => {
  const plan = await loadPlan('auto');
  const execution = selectRootfsExecutionPlan(plan, {
    githubActions: true,
    hasDocker: true,
    dockerDaemonRunning: true,
    hasVirtCustomize: true,
  }, {
    referenceRootfsDir: '/workspace/relay-button/packages/rootfs/reference/uc-go-peer/rootfs',
  });

  assert.equal(execution.mode, 'docker');
});

test('selectRootfsExecutionPlan falls back to host tools when auto driver is local', async () => {
  const plan = await loadPlan('auto');
  const execution = selectRootfsExecutionPlan(plan, {
    hasDocker: false,
    hasVirtCustomize: true,
  }, {
    referenceRootfsDir: '/workspace/relay-button/packages/rootfs/reference/uc-go-peer/rootfs',
  });

  assert.equal(execution.mode, 'host');
});

test('selectRootfsExecutionPlan rejects unavailable explicit drivers', async () => {
  const hostPlan = await loadPlan('host');
  assert.throws(
    () => selectRootfsExecutionPlan(hostPlan, { hasDocker: true, hasVirtCustomize: false }),
    /virt-customize is not available/u,
  );

  const dockerPlan = await loadPlan('docker');
  assert.throws(
    () => selectRootfsExecutionPlan(dockerPlan, { hasDocker: true, dockerDaemonRunning: false, hasVirtCustomize: true }),
    /Docker daemon is not running/u,
  );
});
