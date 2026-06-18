import { pathToFileURL } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { Agent } from "undici";

import {
  buildRootfs,
  createRootfsBuildPlan,
  finalizeRootfsBuildPipeline,
  publicationArtifacts,
  readRootfsContractFile,
  type RootfsBuildPlan,
  type RootfsPublishExecutionResult,
  type RootfsToolchainAvailability,
} from "../../rootfs/src/index.ts";
import { broadcastAlephMessage, normalizeBroadcastStatus, signAlephMessage } from "../../core/src/index.ts";
import { inspectMessageResult, isTransientMessageLookupError } from "../../core/src/deployment-inspection.ts";

import { booleanEnv, optionalEnv, requiredEnv } from "./env.ts";
import { appendGithubOutput, appendGithubSummary } from "./github-outputs.ts";
import { createPrivateKeyIdentity } from "./signer.ts";

export interface ParsedRootfsRunnerInputs {
  buildPlan: RootfsBuildPlan;
  availability: RootfsToolchainAvailability;
  referenceRootfsDir?: string;
  createdAt?: string;
}

interface RootfsIpfsUploadResult {
  cid: string;
  responseText: string;
  sourceSizeBytes?: number;
}

interface RootfsUploadRuntimeOptions {
  driver: 'fetch' | 'curl';
  headersTimeoutMs: number;
  bodyTimeoutMs: number;
  connectTimeoutMs: number;
}

async function commandExists(command: string, pathValue: string): Promise<boolean> {
  for (const segment of pathValue.split(path.delimiter)) {
    const candidate = segment ? path.join(segment, command) : command
    try {
      await access(candidate)
      return true
    } catch {
      continue
    }
  }
  return false
}

async function commandRunsSuccessfully(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: 'ignore',
    })
    child.on('error', () => resolve(false))
    child.on('exit', (code) => resolve(code === 0))
  })
}

async function detectRootfsToolchainAvailability(env: NodeJS.ProcessEnv): Promise<RootfsToolchainAvailability> {
  const pathValue = env.PATH ?? process.env.PATH ?? ''
  const envHasDocker = env.ALEPH_ROOTFS_HAS_DOCKER
  const envDockerDaemonRunning = env.ALEPH_ROOTFS_DOCKER_DAEMON_RUNNING
  const envHasVirtCustomize = env.ALEPH_ROOTFS_HAS_VIRT_CUSTOMIZE

  const hasDocker =
    envHasDocker == null
      ? await commandExists('docker', pathValue)
      : booleanEnv('ALEPH_ROOTFS_HAS_DOCKER', false, env)

  const dockerDaemonRunning =
    envDockerDaemonRunning == null
      ? (hasDocker ? await commandRunsSuccessfully('docker', ['info'], env) : undefined)
      : booleanEnv('ALEPH_ROOTFS_DOCKER_DAEMON_RUNNING', false, env)

  const hasVirtCustomize =
    envHasVirtCustomize == null
      ? await commandExists('virt-customize', pathValue)
      : booleanEnv('ALEPH_ROOTFS_HAS_VIRT_CUSTOMIZE', false, env)

  return {
    githubActions: env.GITHUB_ACTIONS === 'true',
    hasDocker,
    dockerDaemonRunning,
    hasVirtCustomize,
  }
}

async function deriveOrbitdbRelayVersion(
  sourceDir: string,
  profileId: 'orbitdb-relay',
): Promise<string | undefined> {
  const packageJsonPath = path.join(sourceDir, 'package.json')
  try {
    const payload = JSON.parse(await readFile(packageJsonPath, 'utf8')) as { version?: unknown }
    if (typeof payload.version === 'string' && payload.version.trim()) {
      return `${profileId}-v${payload.version.trim().replace(/^v/u, '')}`
    }
  } catch {
    return undefined
  }

  return undefined
}

export async function parseRootfsRunnerInputs(env: NodeJS.ProcessEnv = process.env): Promise<ParsedRootfsRunnerInputs> {
  const contractPath = requiredEnv('ALEPH_ROOTFS_CONTRACT_PATH', env);
  const contract = await readRootfsContractFile(contractPath);
  const orbitdbRelayDir = optionalEnv('ALEPH_ROOTFS_ORBITDB_RELAY_DIR', undefined, env) || undefined
  const explicitRootfsVersion = optionalEnv('ALEPH_ROOTFS_VERSION', undefined, env) || undefined
  const derivedOrbitdbVersion =
    !explicitRootfsVersion &&
    contract.id === 'orbitdb-relay' &&
    orbitdbRelayDir
      ? await deriveOrbitdbRelayVersion(
          orbitdbRelayDir,
          contract.id,
        )
      : undefined
  const buildPlan = createRootfsBuildPlan(contract, {
    projectDir: requiredEnv('ALEPH_ROOTFS_PROJECT_DIR', env),
    orbitdbRelayDir,
    contractPath,
    alephDir: optionalEnv('ALEPH_ROOTFS_ALEPH_DIR', undefined, env) || undefined,
    outDir: optionalEnv('ALEPH_ROOTFS_OUT_DIR', undefined, env) || undefined,
    driver: (optionalEnv('ALEPH_ROOTFS_DRIVER', 'auto', env) as 'auto' | 'host' | 'docker'),
    rootfsVersion: explicitRootfsVersion ?? derivedOrbitdbVersion,
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
    availability: await detectRootfsToolchainAvailability(env),
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

async function sha256Hex(payload: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload))
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function positiveTimeoutMs(value: string | undefined, fallback: number): number {
  const normalized = (value ?? '').trim()
  if (!normalized) return fallback
  const parsed = Number(normalized)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function rootfsUploadRuntimeOptions(env: NodeJS.ProcessEnv = process.env): RootfsUploadRuntimeOptions {
  const driver = optionalEnv('ALEPH_ROOTFS_UPLOAD_DRIVER', 'fetch', env).trim().toLowerCase()
  if (driver !== 'fetch' && driver !== 'curl') {
    throw new Error(`Unsupported ALEPH_ROOTFS_UPLOAD_DRIVER "${driver}". Expected "fetch" or "curl".`)
  }

  return {
    driver,
    headersTimeoutMs: positiveTimeoutMs(env.ALEPH_ROOTFS_UPLOAD_HEADERS_TIMEOUT_MS, 15 * 60 * 1000),
    bodyTimeoutMs: positiveTimeoutMs(env.ALEPH_ROOTFS_UPLOAD_BODY_TIMEOUT_MS, 15 * 60 * 1000),
    connectTimeoutMs: positiveTimeoutMs(env.ALEPH_ROOTFS_UPLOAD_CONNECT_TIMEOUT_MS, 30 * 1000),
  }
}

function describeUploadError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error)
  }

  const details = [
    `${error.name}: ${error.message}`,
  ]
  if (error.cause !== undefined) {
    if (error.cause instanceof Error) {
      details.push(`cause=${error.cause.name}: ${error.cause.message}`)
    } else {
      details.push(`cause=${String(error.cause)}`)
    }
  }
  return details.join('; ')
}

async function uploadRootfsImageToIpfsWithFetch(
  buildPlan: RootfsBuildPlan,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RootfsIpfsUploadResult> {
  const runtime = rootfsUploadRuntimeOptions(env)
  const dispatcher = new Agent({
    connect: {
      timeout: runtime.connectTimeoutMs,
    },
    headersTimeout: runtime.headersTimeoutMs,
    bodyTimeout: runtime.bodyTimeoutMs,
  })

  try {
    const bytes = await readFile(buildPlan.imagePath)
    const file = new File([bytes], path.basename(buildPlan.imagePath))
    const formData = new FormData()
    formData.append('file', file)

    const response = await fetch(
      buildPlan.ipfsAddUrl,
      {
        method: 'POST',
        body: formData,
        dispatcher,
      } as RequestInit & { dispatcher: Agent },
    )
    if (!response.ok) {
      throw new Error(`IPFS upload failed with ${response.status} ${response.statusText}`)
    }

    const responseText = await response.text()
    const lines = responseText.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)
    if (lines.length === 0) {
      throw new Error('No response received from the IPFS add endpoint')
    }

    const payload = JSON.parse(lines.at(-1) ?? '{}') as { Hash?: string; Size?: string | number }
    const cid = payload.Hash?.trim()
    if (!cid) {
      throw new Error(`IPFS add response did not include a Hash: ${JSON.stringify(payload)}`)
    }

    let sourceSizeBytes: number | undefined
    if (typeof payload.Size === 'number' && Number.isFinite(payload.Size) && payload.Size > 0) {
      sourceSizeBytes = payload.Size
    } else if (typeof payload.Size === 'string' && /^\d+$/u.test(payload.Size)) {
      sourceSizeBytes = Number(payload.Size)
    }

    return { cid, responseText, sourceSizeBytes }
  } catch (error) {
    throw new Error(
      `IPFS upload via fetch failed for ${buildPlan.imagePath} -> ${buildPlan.ipfsAddUrl}; headersTimeoutMs=${runtime.headersTimeoutMs}; bodyTimeoutMs=${runtime.bodyTimeoutMs}; connectTimeoutMs=${runtime.connectTimeoutMs}; ${describeUploadError(error)}`,
      { cause: error },
    )
  } finally {
    await dispatcher.close()
  }
}

async function uploadRootfsImageToIpfsWithCurl(buildPlan: RootfsBuildPlan): Promise<RootfsIpfsUploadResult> {
  const responseText = await new Promise<string>((resolve, reject) => {
    const curl = spawn(
      'curl',
      [
        '--fail',
        '--silent',
        '--show-error',
        '-X',
        'POST',
        '-F',
        `file=@${buildPlan.imagePath}`,
        buildPlan.ipfsAddUrl,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )

    let stdout = ''
    let stderr = ''
    curl.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    curl.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    curl.on('error', (error) => {
      reject(error)
    })
    curl.on('close', (code) => {
      if (code === 0) {
        resolve(stdout)
        return
      }

      const details = stderr.trim()
      reject(new Error(details ? `IPFS upload failed: ${details}` : `curl failed with exit code ${code ?? 'unknown'}`))
    })
  })

  const lines = responseText.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)
  if (lines.length === 0) {
    throw new Error('No response received from the IPFS add endpoint')
  }

  const payload = JSON.parse(lines.at(-1) ?? '{}') as { Hash?: string; Size?: string | number }
  const cid = payload.Hash?.trim()
  if (!cid) {
    throw new Error(`IPFS add response did not include a Hash: ${JSON.stringify(payload)}`)
  }

  let sourceSizeBytes: number | undefined
  if (typeof payload.Size === 'number' && Number.isFinite(payload.Size) && payload.Size > 0) {
    sourceSizeBytes = payload.Size
  } else if (typeof payload.Size === 'string' && /^\d+$/u.test(payload.Size)) {
    sourceSizeBytes = Number(payload.Size)
  }

  return { cid, responseText, sourceSizeBytes }
}

async function uploadRootfsImageToIpfs(
  buildPlan: RootfsBuildPlan,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RootfsIpfsUploadResult> {
  const runtime = rootfsUploadRuntimeOptions(env)
  switch (runtime.driver) {
    case 'fetch':
      return uploadRootfsImageToIpfsWithFetch(buildPlan, env)
    case 'curl':
      return uploadRootfsImageToIpfsWithCurl(buildPlan)
  }
}

async function waitForIpfsCidAvailable(buildPlan: RootfsBuildPlan, cid: string): Promise<void> {
  const gatewayUrl = `${buildPlan.ipfsGatewayUrl.replace(/\/+$/u, '')}/${cid}`
  for (let attempt = 1; attempt <= buildPlan.ipfsGatewayWaitAttempts; attempt += 1) {
    try {
      const response = await fetch(gatewayUrl, {
        method: 'GET',
        headers: { range: 'bytes=0-0' },
      })
      if (response.status === 200 || response.status === 206) {
        return
      }
    } catch {
      // retry below
    }

    if (attempt < buildPlan.ipfsGatewayWaitAttempts) {
      await new Promise((resolve) => setTimeout(resolve, buildPlan.ipfsGatewayWaitDelaySeconds * 1000))
    }
  }

  throw new Error(`CID ${cid} did not become retrievable from ${buildPlan.ipfsGatewayUrl} after ${buildPlan.ipfsGatewayWaitAttempts} attempts.`)
}

async function pinRootfsCidOnAleph(buildPlan: RootfsBuildPlan, cid: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const privateKey = requiredEnv('ALEPH_PRIVATE_KEY', env)
  const identity = await createPrivateKeyIdentity(privateKey)
  const now = Date.now() / 1000
  const ref = optionalEnv('ALEPH_ROOTFS_REF', '', env).trim() || undefined
  const content = {
    address: identity.address,
    time: now,
    item_type: 'ipfs' as const,
    item_hash: cid,
    ...(ref ? { ref } : {}),
  }
  const itemContent = JSON.stringify(content)
  const unsignedMessage = {
    sender: identity.address,
    chain: 'ETH' as const,
    type: 'STORE' as const,
    item_hash: await sha256Hex(itemContent),
    item_type: 'inline' as const,
    item_content: itemContent,
    time: now,
    channel: buildPlan.channel,
  }
  const message = await signAlephMessage(unsignedMessage, identity.signer)
  const { response, httpStatus } = await broadcastAlephMessage(message, {
    apiHost: buildPlan.alephApiHost,
    sync: true,
    fetch,
  })
  const status = normalizeBroadcastStatus(httpStatus, response?.message_status)
  if (status === 'rejected') {
    throw new Error(`Aleph STORE pin was rejected: ${JSON.stringify(response?.details ?? response ?? {})}`)
  }
  return typeof response?.item_hash === 'string' ? response.item_hash : message.item_hash
}

async function waitForAlephMessageProcessed(buildPlan: RootfsBuildPlan, itemHash: string): Promise<void> {
  for (let attempt = 1; attempt <= buildPlan.alephMessageWaitAttempts; attempt += 1) {
    try {
      const result = await inspectMessageResult(itemHash, {
        apiHost: buildPlan.alephApiHost,
        fetch,
        label: 'Aleph STORE message',
      })
      if (result.status === 'processed') return
      if (result.status === 'rejected') {
        throw new Error(result.rejectionReason ?? `Aleph STORE message ${itemHash} was rejected.`)
      }
    } catch (error) {
      if (!isTransientMessageLookupError(error) || attempt >= buildPlan.alephMessageWaitAttempts) {
        throw error
      }
    }
    if (attempt < buildPlan.alephMessageWaitAttempts) {
      await new Promise((resolve) => setTimeout(resolve, buildPlan.alephMessageWaitDelaySeconds * 1000))
    }
  }

  throw new Error(`Aleph STORE message ${itemHash} did not become processed in time.`)
}

async function writeRootfsManifestOutputs(result: RootfsPublishExecutionResult): Promise<void> {
  const { manifestJson, manifestPaths } = result.finalized
  await mkdir(path.dirname(manifestPaths.primaryPath), { recursive: true })
  await writeFile(manifestPaths.primaryPath, manifestJson)
  if (manifestPaths.copyTargetPath) {
    await mkdir(path.dirname(manifestPaths.copyTargetPath), { recursive: true })
    await writeFile(manifestPaths.copyTargetPath, manifestJson)
  }
  if (manifestPaths.versionedTargetPath) {
    await mkdir(path.dirname(manifestPaths.versionedTargetPath), { recursive: true })
    await writeFile(manifestPaths.versionedTargetPath, manifestJson)
  }
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
    '## Aleph Rootfs Runner',
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
    runCommand?: typeof runLocalCommand;
    uploadRootfsImageToIpfs?: typeof uploadRootfsImageToIpfs;
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
    const originalPlan = parsed.buildPlan
    const buildPlan = originalPlan.skipUpload ? originalPlan : { ...originalPlan, skipUpload: true }
    const buildResult = await (hooks.buildRootfs ?? buildRootfs)(
      buildPlan,
      { run: hooks.runCommand ?? runLocalCommand },
      parsed.availability,
      { referenceRootfsDir: parsed.referenceRootfsDir },
    )

    let ipfsAddResponseContent: string | undefined
    let storeMessageContent: string | undefined
    if (!originalPlan.skipUpload) {
      const upload = hooks.uploadRootfsImageToIpfs
        ? await hooks.uploadRootfsImageToIpfs(originalPlan)
        : await uploadRootfsImageToIpfs(originalPlan, env)
      await waitForIpfsCidAvailable(originalPlan, upload.cid)
      const itemHash = await pinRootfsCidOnAleph(originalPlan, upload.cid, env)
      await waitForAlephMessageProcessed(originalPlan, itemHash)

      const artifacts = publicationArtifacts(originalPlan)
      await mkdir(originalPlan.outDir, { recursive: true })
      await writeFile(artifacts.ipfsAddResponsePath, upload.responseText.endsWith('\n') ? upload.responseText : `${upload.responseText}\n`)
      storeMessageContent = JSON.stringify({ item_hash: itemHash })
      await writeFile(artifacts.storeMessagePath, `${storeMessageContent}\n`)
      await writeFile(artifacts.storeMessageStderrPath, '')
      ipfsAddResponseContent = upload.responseText
    }

    const finalized = finalizeRootfsBuildPipeline(originalPlan, {
      createdAt: parsed.createdAt,
      ipfsAddResponseContent,
      storeMessageContent,
    })
    const result: RootfsPublishExecutionResult = {
      pipeline: {
        ...buildResult.pipeline,
        buildPlan: originalPlan,
        publicationArtifacts: publicationArtifacts(originalPlan),
        manifestPaths: finalized.manifestPaths,
      },
      executedCommands: buildResult.executedCommands,
      finalized,
    }
    await writeRootfsManifestOutputs(result)
    await emitRootfsOutputs(result, env);
    stdout(`${JSON.stringify(result.finalized)}\n`);
    return;
  }

  throw new Error(`Unsupported ALEPH_VM_MODE "${mode}" in Aleph rootfs runner.`);
}

export async function rootfsMain(): Promise<void> {
  await runRootfsMode(process.env);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  rootfsMain().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
