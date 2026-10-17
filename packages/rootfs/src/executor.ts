import path from "node:path";

import { rootfsBuildShellEnv, type RootfsBuildPlan } from "./build-plan.ts";
import {
  createRootfsBuildPipeline,
  finalizeRootfsBuildPipeline,
  type RootfsBuildPipeline,
  type RootfsFinalizeResult,
} from "./orchestration.ts";
import { type RootfsExecutionPlanOptions, type RootfsToolchainAvailability } from "./execution-plan.ts";
import { referenceProfileRootfsDir } from "./contract.ts";

export interface RootfsExecutedCommand {
  command: string;
  args: string[];
  workdir?: string;
  env?: Record<string, string>;
}

export interface RootfsCommandRunner {
  run(command: RootfsExecutedCommand): Promise<void>;
}

export interface RootfsFileReader {
  readText(path: string): Promise<string>;
}

export interface RootfsExecutorDependencies extends RootfsCommandRunner, RootfsFileReader {}

export interface RootfsExecutionResult {
  pipeline: RootfsBuildPipeline;
  executedCommands: RootfsExecutedCommand[];
}

export interface RootfsPublishExecutionResult extends RootfsExecutionResult {
  finalized: RootfsFinalizeResult;
}

export interface RootfsPublishOptions extends RootfsExecutionPlanOptions {
  createdAt?: string;
  referenceRootfsDir?: string;
}

function rootfsScriptDir(buildPlan: RootfsBuildPlan, override?: string): string {
  return override ? path.resolve(override) : referenceProfileRootfsDir(buildPlan.contract.id);
}

export function createRootfsScriptCommand(buildPlan: RootfsBuildPlan, referenceRootfsDir?: string): RootfsExecutedCommand {
  const scriptDir = rootfsScriptDir(buildPlan, referenceRootfsDir);
  return {
    command: '/bin/bash',
    args: [path.join(scriptDir, 'build-rootfs.sh')],
    workdir: scriptDir,
    env: rootfsBuildShellEnv(buildPlan),
  };
}

export async function buildRootfs(
  buildPlan: RootfsBuildPlan,
  deps: RootfsCommandRunner,
  availability: RootfsToolchainAvailability,
  options: RootfsExecutionPlanOptions = {},
): Promise<RootfsExecutionResult> {
  const pipeline = createRootfsBuildPipeline(buildPlan, availability, options);
  const executedCommands: RootfsExecutedCommand[] = [];

  for (const asset of pipeline.executionPlan.assetCommands ?? []) {
    const assetCommand: RootfsExecutedCommand = { command: asset.command, args: asset.args, workdir: asset.workdir, env: asset.env };
    await deps.run(assetCommand);
    executedCommands.push(assetCommand);
  }

  if (pipeline.executionPlan.prepareCommand) {
    const prepareCommand: RootfsExecutedCommand = {
      command: pipeline.executionPlan.prepareCommand.command,
      args: pipeline.executionPlan.prepareCommand.args,
      workdir: pipeline.executionPlan.prepareCommand.workdir,
      env: pipeline.executionPlan.prepareCommand.env,
    };
    await deps.run(prepareCommand);
    executedCommands.push(prepareCommand);
  }

  const runCommand: RootfsExecutedCommand = {
    command: pipeline.executionPlan.runCommand.command,
    args: pipeline.executionPlan.runCommand.args,
    workdir: pipeline.executionPlan.runCommand.workdir,
    env: pipeline.executionPlan.runCommand.env,
  };
  await deps.run(runCommand);
  executedCommands.push(runCommand);

  return {
    pipeline,
    executedCommands,
  };
}

export async function publishRootfs(
  buildPlan: RootfsBuildPlan,
  deps: RootfsExecutorDependencies,
  options: RootfsPublishOptions = {},
): Promise<RootfsPublishExecutionResult> {
  const command = createRootfsScriptCommand(buildPlan, options.referenceRootfsDir);
  await deps.run(command);

  let ipfsAddResponseContent: string | undefined;
  let storeMessageContent: string | undefined;
  const publicationArtifacts = {
    ipfsAddResponsePath: path.join(buildPlan.outDir, 'ipfs-add-response.jsonl'),
    storeMessagePath: path.join(buildPlan.outDir, 'store-message.json'),
    storeMessageStderrPath: path.join(buildPlan.outDir, 'store-message.stderr.log'),
  };

  if (!buildPlan.skipUpload) {
    ipfsAddResponseContent = await deps.readText(publicationArtifacts.ipfsAddResponsePath);
    storeMessageContent = await deps.readText(publicationArtifacts.storeMessagePath);
  }

  const finalized = finalizeRootfsBuildPipeline(buildPlan, {
    createdAt: options.createdAt,
    ipfsAddResponseContent,
    storeMessageContent,
  });

  return {
    pipeline: {
      buildPlan,
      executionPlan: {
        mode: 'docker',
        reason: 'Running shared rootfs build orchestrator script.',
        referenceRootfsDir: command.workdir ?? rootfsScriptDir(buildPlan, options.referenceRootfsDir),
        runCommand: {
          command: command.command,
          args: command.args,
          workdir: command.workdir,
          env: command.env,
        },
      },
      publicationArtifacts,
      manifestPaths: finalized.manifestPaths,
    },
    executedCommands: [command],
    finalized,
  };
}
