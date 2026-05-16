import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";

import {
  buildRootfs,
  createRootfsBuildPlan,
  publishRootfs,
  readRootfsContractFile,
  type RootfsBuildPlan,
  type RootfsPublishExecutionResult,
  type RootfsToolchainAvailability,
} from "../../rootfs/src/index.ts";

import { booleanEnv, optionalEnv, requiredEnv } from "./env.ts";
import { appendGithubOutput, appendGithubSummary } from "./github-outputs.ts";

export interface ParsedRootfsRunnerInputs {
  buildPlan: RootfsBuildPlan;
  availability: RootfsToolchainAvailability;
  referenceRootfsDir?: string;
  createdAt?: string;
}

export async function parseRootfsRunnerInputs(env: NodeJS.ProcessEnv = process.env): Promise<ParsedRootfsRunnerInputs> {
  const contractPath = requiredEnv('ALEPH_ROOTFS_CONTRACT_PATH', env);
  const contract = await readRootfsContractFile(contractPath);
  const buildPlan = createRootfsBuildPlan(contract, {
    projectDir: requiredEnv('ALEPH_ROOTFS_PROJECT_DIR', env),
    contractPath,
    alephDir: optionalEnv('ALEPH_ROOTFS_ALEPH_DIR', undefined, env) || undefined,
    outDir: optionalEnv('ALEPH_ROOTFS_OUT_DIR', undefined, env) || undefined,
    driver: (optionalEnv('ALEPH_ROOTFS_DRIVER', 'auto', env) as 'auto' | 'host' | 'docker'),
    rootfsVersion: optionalEnv('ALEPH_ROOTFS_VERSION', undefined, env) || undefined,
    rootfsSizeMiB: Number(optionalEnv('ALEPH_ROOTFS_SIZE_MIB', '', env)) || undefined,
    rootfsImageSize: optionalEnv('ALEPH_ROOTFS_IMAGE_SIZE', undefined, env) || undefined,
    channel: optionalEnv('ALEPH_ROOTFS_CHANNEL', undefined, env) || undefined,
    skipUpload: booleanEnv('ALEPH_ROOTFS_SKIP_UPLOAD', false, env),
    skipBuild: booleanEnv('ALEPH_ROOTFS_SKIP_BUILD', false, env),
    ipfsAddUrl: optionalEnv('ALEPH_ROOTFS_IPFS_ADD_URL', undefined, env) || undefined,
    ipfsGatewayUrl: optionalEnv('ALEPH_ROOTFS_IPFS_GATEWAY_URL', undefined, env) || undefined,
    alephApiHost: optionalEnv('ALEPH_ROOTFS_ALEPH_API_HOST', undefined, env) || undefined,
    alephMessageWaitAttempts: Number(optionalEnv('ALEPH_ROOTFS_ALEPH_MESSAGE_WAIT_ATTEMPTS', '', env)) || undefined,
    alephMessageWaitDelaySeconds: Number(optionalEnv('ALEPH_ROOTFS_ALEPH_MESSAGE_WAIT_DELAY_SECONDS', '', env)) || undefined,
    alephPinAttempts: Number(optionalEnv('ALEPH_ROOTFS_ALEPH_PIN_ATTEMPTS', '', env)) || undefined,
    alephPinDelaySeconds: Number(optionalEnv('ALEPH_ROOTFS_ALEPH_PIN_DELAY_SECONDS', '', env)) || undefined,
    ipfsGatewayWaitAttempts: Number(optionalEnv('ALEPH_ROOTFS_IPFS_GATEWAY_WAIT_ATTEMPTS', '', env)) || undefined,
    ipfsGatewayWaitDelaySeconds: Number(optionalEnv('ALEPH_ROOTFS_IPFS_GATEWAY_WAIT_DELAY_SECONDS', '', env)) || undefined,
  });

  return {
    buildPlan,
    availability: {
      githubActions: env.GITHUB_ACTIONS === 'true',
      hasDocker: booleanEnv('ALEPH_ROOTFS_HAS_DOCKER', false, env),
      dockerDaemonRunning: env.ALEPH_ROOTFS_DOCKER_DAEMON_RUNNING == null ? undefined : booleanEnv('ALEPH_ROOTFS_DOCKER_DAEMON_RUNNING', false, env),
      hasVirtCustomize: booleanEnv('ALEPH_ROOTFS_HAS_VIRT_CUSTOMIZE', false, env),
    },
    referenceRootfsDir: optionalEnv('ALEPH_ROOTFS_REFERENCE_ROOTFS_DIR', undefined, env) || undefined,
    createdAt: optionalEnv('ALEPH_ROOTFS_CREATED_AT', undefined, env) || undefined,
  };
}

export async function runLocalCommand(command: {
  command: string;
  args: string[];
  workdir?: string;
  env?: Record<string, string>;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.command, command.args, {
      cwd: command.workdir,
      env: { ...process.env, ...command.env },
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command.command} ${command.args.join(' ')} failed with exit code ${code ?? 'unknown'}`));
      }
    });
  });
}

export async function emitRootfsOutputs(result: RootfsPublishExecutionResult, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await appendGithubOutput('rootfs_version', result.finalized.manifest.version, env);
  await appendGithubOutput('rootfs_manifest_path', result.finalized.manifestPaths.primaryPath, env);
  await appendGithubOutput('rootfs_manifest_json', result.finalized.manifestJson, env);
  await appendGithubOutput('rootfs_image_path', result.pipeline.buildPlan.imagePath, env);
  await appendGithubOutput('rootfs_execution_mode', result.pipeline.executionPlan.mode, env);
  if (result.finalized.manifestPaths.copyTargetPath) {
    await appendGithubOutput('rootfs_manifest_copy_target_path', result.finalized.manifestPaths.copyTargetPath, env);
  }
  if (result.finalized.manifestPaths.versionedTargetPath) {
    await appendGithubOutput('rootfs_manifest_versioned_path', result.finalized.manifestPaths.versionedTargetPath, env);
  }
  if (result.finalized.publication?.cid) {
    await appendGithubOutput('rootfs_cid', result.finalized.publication.cid, env);
  }
  if (result.finalized.publication?.itemHash) {
    await appendGithubOutput('rootfs_item_hash', result.finalized.publication.itemHash, env);
  }
  if (typeof result.finalized.publication?.sourceSizeBytes === 'number') {
    await appendGithubOutput('rootfs_source_size_bytes', result.finalized.publication.sourceSizeBytes, env);
  }
  await appendGithubSummary([
    '## Shared Rootfs Runner',
    '',
    `- Version: \`${result.finalized.manifest.version}\``,
    `- Execution mode: \`${result.pipeline.executionPlan.mode}\``,
    `- Image path: \`${result.pipeline.buildPlan.imagePath}\``,
    `- Manifest path: \`${result.finalized.manifestPaths.primaryPath}\``,
    `- Published CID: \`${result.finalized.publication?.cid ?? ''}\``,
    `- Aleph item hash: \`${result.finalized.publication?.itemHash ?? ''}\``,
  ], env);
}

export async function runRootfsMode(
  env: NodeJS.ProcessEnv = process.env,
  hooks: {
    stdout?: (text: string) => void;
    parseInputs?: typeof parseRootfsRunnerInputs;
    buildRootfs?: typeof buildRootfs;
    publishRootfs?: typeof publishRootfs;
    runCommand?: typeof runLocalCommand;
    readText?: (targetPath: string) => Promise<string>;
  } = {},
): Promise<void> {
  const mode = optionalEnv('ALEPH_VM_MODE', 'rootfs-publish', env);
  const stdout = hooks.stdout ?? ((text: string) => process.stdout.write(text));
  const parsed = await (hooks.parseInputs ?? parseRootfsRunnerInputs)(env);

  if (mode === 'rootfs-build-plan') {
    stdout(`${JSON.stringify(parsed.buildPlan)}\n`);
    return;
  }

  if (mode === 'rootfs-build') {
    const result = await (hooks.buildRootfs ?? buildRootfs)(
      parsed.buildPlan,
      { run: hooks.runCommand ?? runLocalCommand },
      parsed.availability,
      { referenceRootfsDir: parsed.referenceRootfsDir },
    );
    stdout(`${JSON.stringify(result.pipeline)}\n`);
    return;
  }

  if (mode === 'rootfs-publish') {
    const result = await (hooks.publishRootfs ?? publishRootfs)(
      parsed.buildPlan,
      {
        run: hooks.runCommand ?? runLocalCommand,
        readText: hooks.readText ?? ((targetPath: string) => readFile(targetPath, 'utf8')),
      },
      { createdAt: parsed.createdAt, referenceRootfsDir: parsed.referenceRootfsDir },
    );
    await emitRootfsOutputs(result, env);
    stdout(`${JSON.stringify(result.finalized)}\n`);
    return;
  }

  throw new Error(`Unsupported ALEPH_VM_MODE "${mode}" in shared rootfs runner.`);
}
