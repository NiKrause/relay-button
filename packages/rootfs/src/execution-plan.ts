import path from "node:path";

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
      env: {
        PROJECT_DIR: plan.projectDir,
        OUT_DIR: plan.outDir,
        ROOTFS_CONTRACT_FILE: plan.contractPath,
        ROOTFS_IMAGE_SIZE: plan.rootfsImageSize,
      },
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
  const dockerImageTag = options.dockerImageTag ?? `${plan.contract.id}-rootfs-builder:local`;

  const containerProjectDir = projectMountPath;
  const containerContractPath = containerPathForProjectFile(plan.contractPath, plan.projectDir, projectMountPath, 'contractPath');
  const containerOutDir = containerPathForProjectFile(plan.outDir, plan.projectDir, projectMountPath, 'outDir');
  const hostUid = typeof process.getuid === 'function' ? String(process.getuid()) : '1000';
  const hostGid = typeof process.getgid === 'function' ? String(process.getgid()) : '1000';

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
        '-e',
        `ROOTFS_CONTRACT_FILE=${containerContractPath}`,
        '-e',
        `OUT_DIR=${containerOutDir}`,
        '-e',
        `ROOTFS_IMAGE_SIZE=${plan.rootfsImageSize}`,
        '-e',
        `PROJECT_DIR=${containerProjectDir}`,
        '-e',
        `HOST_UID=${hostUid}`,
        '-e',
        `HOST_GID=${hostGid}`,
        '-v',
        `${plan.projectDir}:${projectMountPath}`,
        '-v',
        `${referenceRootfsDir}:${rootfsMountPath}`,
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
