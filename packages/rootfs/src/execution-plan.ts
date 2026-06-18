import path from "node:path";

import { rootfsBuildShellEnv } from "./build-plan.ts";
import { referenceProfileRootfsDir, type RootfsContract } from "./contract.ts";
import { type RootfsBuildPlan } from "./build-plan.ts";

export interface RootfsToolchainAvailability {
  hasDocker: boolean;
  dockerDaemonRunning?: boolean;
  hasVirtCustomize: boolean;
  githubActions?: boolean;
}

export interface RootfsCommandPlan {
  command: string;
  args: string[];
  env?: Record<string, string>;
  workdir?: string;
}

export interface RootfsExecutionPlan {
  mode: "host" | "docker";
  reason: string;
  referenceRootfsDir: string;
  prepareCommand?: RootfsCommandPlan;
  runCommand: RootfsCommandPlan;
}

export interface RootfsExecutionPlanOptions {
  referenceRootfsDir?: string;
  projectMountPath?: string;
  rootfsMountPath?: string;
  orbitdbRelayMountPath?: string;
  dockerImageTag?: string;
}

function ensurePathWithin(parent: string, child: string, label: string): string {
  const relative = path.relative(parent, child);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} must be inside ${parent}`);
  }
  return relative || '.';
}

function containerPathForProjectFile(hostPath: string, projectDir: string, mountPath: string, label: string): string {
  const relative = ensurePathWithin(projectDir, hostPath, label);
  return path.posix.join(mountPath, relative.split(path.sep).join('/'));
}

function containerContractPathForFile(hostPath: string, projectDir: string, projectMountPath: string): string {
  const relative = path.relative(projectDir, hostPath);
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
    return path.posix.join(projectMountPath, relative.split(path.sep).join('/'));
  }

  const basename = path.posix.basename(hostPath);
  return path.posix.join('/workspace/shared-contracts', basename);
}

function resolveReferenceRootfsDir(contract: RootfsContract, override?: string): string {
  if (override) {
    return path.resolve(override);
  }
  return referenceProfileRootfsDir(contract.id);
}

export function createHostRootfsExecutionPlan(
  plan: RootfsBuildPlan,
  options: RootfsExecutionPlanOptions = {},
): RootfsExecutionPlan {
  const referenceRootfsDir = resolveReferenceRootfsDir(plan.contract, options.referenceRootfsDir);
  return {
    mode: 'host',
    reason: 'Using host virt-customize/qemu-img toolchain.',
    referenceRootfsDir,
    runCommand: {
      command: '/bin/bash',
      args: [path.join(referenceRootfsDir, 'build-rootfs-image.sh')],
      workdir: referenceRootfsDir,
      env: rootfsBuildShellEnv(plan),
    },
  };
}

export function createDockerRootfsExecutionPlan(
  plan: RootfsBuildPlan,
  options: RootfsExecutionPlanOptions = {},
): RootfsExecutionPlan {
  const referenceRootfsDir = resolveReferenceRootfsDir(plan.contract, options.referenceRootfsDir);
  const projectMountPath = options.projectMountPath ?? '/workspace/project';
  const rootfsMountPath = options.rootfsMountPath ?? '/workspace/shared-rootfs';
  const orbitdbRelayMountPath = options.orbitdbRelayMountPath ?? '/workspace-orbitdb-relay';
  const dockerImageTag = options.dockerImageTag ?? `${plan.contract.id}-rootfs-builder:local`;

  const containerProjectDir = projectMountPath;
  const containerContractPath = containerContractPathForFile(plan.contractPath, plan.projectDir, projectMountPath);
  const containerOutDir = containerPathForProjectFile(plan.outDir, plan.projectDir, projectMountPath, 'outDir');
  const hostUid = typeof process.getuid === 'function' ? String(process.getuid()) : '1000';
  const hostGid = typeof process.getgid === 'function' ? String(process.getgid()) : '1000';
  const runEnv: Record<string, string> = {
    ...rootfsBuildShellEnv(plan),
    PROJECT_DIR: containerProjectDir,
    OUT_DIR: containerOutDir,
    ROOTFS_CONTRACT_FILE: containerContractPath,
    HOST_UID: hostUid,
    HOST_GID: hostGid,
  };
  const volumeMounts = [
    '-v',
    `${plan.projectDir}:${projectMountPath}`,
    '-v',
    `${referenceRootfsDir}:${rootfsMountPath}`,
  ];

  const contractRelative = path.relative(plan.projectDir, plan.contractPath);
  if (contractRelative.startsWith('..') || path.isAbsolute(contractRelative)) {
    volumeMounts.push('-v', `${plan.contractPath}:${containerContractPath}:ro`);
  }

  if (plan.orbitdbRelayDir) {
    runEnv.ORBITDB_RELAY_DIR = orbitdbRelayMountPath;
    volumeMounts.push('-v', `${plan.orbitdbRelayDir}:${orbitdbRelayMountPath}:ro`);
  }

  return {
    mode: 'docker',
    reason: 'Using Dockerized Debian/libguestfs builder.',
    referenceRootfsDir,
    prepareCommand: {
      command: 'docker',
      args: [
        'build',
        '--platform',
        'linux/amd64',
        '-t',
        dockerImageTag,
        '-f',
        path.join(referenceRootfsDir, 'Dockerfile.rootfs'),
        referenceRootfsDir,
      ],
    },
    runCommand: {
      command: 'docker',
      args: [
        'run',
        '--rm',
        '--privileged',
        '--platform',
        'linux/amd64',
        '-e',
        'LIBGUESTFS_BACKEND=direct',
        ...Object.entries(runEnv).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
        ...volumeMounts,
        '-w',
        rootfsMountPath,
        dockerImageTag,
        '/bin/bash',
        path.posix.join(rootfsMountPath, 'build-rootfs-image.sh'),
      ],
    },
  };
}

export function selectRootfsExecutionPlan(
  plan: RootfsBuildPlan,
  availability: RootfsToolchainAvailability,
  options: RootfsExecutionPlanOptions = {},
): RootfsExecutionPlan {
  if (plan.driver === 'host') {
    if (!availability.hasVirtCustomize) {
      throw new Error('ROOTFS_BUILD_DRIVER=host requested, but virt-customize is not available.');
    }
    return createHostRootfsExecutionPlan(plan, options);
  }

  if (plan.driver === 'docker') {
    if (!availability.hasDocker) {
      throw new Error('ROOTFS_BUILD_DRIVER=docker requested, but docker is not available.');
    }
        if (availability.dockerDaemonRunning === false) {
      throw new Error('ROOTFS_BUILD_DRIVER=docker requested, but the Docker daemon is not running.');
    }
    return createDockerRootfsExecutionPlan(plan, options);
  }

  if (availability.githubActions && availability.hasDocker && availability.dockerDaemonRunning !== false) {
    return createDockerRootfsExecutionPlan(plan, options);
  }
  if (availability.hasVirtCustomize) {
    return createHostRootfsExecutionPlan(plan, options);
  }
  if (availability.hasDocker && availability.dockerDaemonRunning !== false) {
    return createDockerRootfsExecutionPlan(plan, options);
  }

  throw new Error('No supported rootfs build toolchain is available.');
}
