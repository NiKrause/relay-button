import process from "node:process"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

import { inspectMessageResult } from "../../core/src/deployment-inspection.ts"

import { optionalEnv, requiredEnv } from "./env.ts"
import { appendGithubOutput, appendGithubSummary } from "./github-outputs.ts"

export interface RunResult {
  stdout: string
  stderr: string
  exitCode: number
}

async function runCapture(command: string, args: string[], options: { cwd?: string; env?: Record<string, string> } = {}): Promise<RunResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', reject)
    child.on('exit', (exitCode) => resolve({ stdout, stderr, exitCode: exitCode ?? 1 }))
  })
}

export function parseLastJsonObject(text: string): Record<string, unknown> {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const candidate = lines[index]?.trimStart() ?? ''
    if (!candidate.startsWith('{')) continue
    const suffix = lines.slice(index).join('\n')
    try {
      return JSON.parse(suffix) as Record<string, unknown>
    } catch {
      // Keep scanning upward until we find a complete trailing JSON object.
    }
  }
  throw new Error(`Could not parse JSON object from output: ${text}`)
}

async function waitForAlephMessage(itemHash: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const apiHost = optionalEnv('ALEPH_SITE_ALEPH_API_HOST', 'https://api2.aleph.im', env)
  const attempts = Number(optionalEnv('ALEPH_SITE_ALEPH_MESSAGE_WAIT_ATTEMPTS', '60', env))
  const delayMs = Number(optionalEnv('ALEPH_SITE_ALEPH_MESSAGE_WAIT_DELAY_MS', '5000', env))

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await inspectMessageResult(itemHash, {
      apiHost,
      fetch: fetch,
      label: 'Aleph STORE message',
    })
    if (result.status === 'processed') return
    if (result.status === 'rejected') {
      throw new Error(result.rejectionReason ?? `Aleph STORE message ${itemHash} was rejected.`)
    }
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }

  throw new Error(`Aleph STORE message ${itemHash} did not become processed in time.`)
}

function defaultSitePublishScriptPath(): string {
  return fileURLToPath(new URL('../reference/publish-static-site.py', import.meta.url))
}

function mergedAddrs(env: NodeJS.ProcessEnv = process.env): string[] {
  const combined: string[] = []
  for (const key of ['PROBE_MULTIADDRS_JSON', 'BROWSER_BOOTSTRAP_MULTIADDRS_JSON']) {
    const raw = env[key] ?? '[]'
    for (const value of JSON.parse(raw)) {
      if (typeof value === 'string') {
        const trimmed = value.trim()
        if (trimmed) combined.push(trimmed)
      }
    }
  }
  return Array.from(new Set(combined))
}

export async function runSitePublishMode(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const projectDir = requiredEnv('ALEPH_SITE_PROJECT_DIR', env)
  const publishScript = optionalEnv('ALEPH_SITE_PUBLISH_SCRIPT', defaultSitePublishScriptPath(), env)
  const siteDirectory = requiredEnv('ALEPH_SITE_DIRECTORY', env)
  const pythonBin = optionalEnv('ALEPH_SITE_PYTHON', 'python3', env)
  const alephBin = optionalEnv('ALEPH_SITE_ALEPH_BIN', 'aleph', env)
  const pin = optionalEnv('ALEPH_SITE_PIN', 'true', env) === 'true'

  const publish = await runCapture(pythonBin, [publishScript, siteDirectory], { cwd: projectDir })
  process.stdout.write(publish.stdout)
  if (publish.stderr) process.stderr.write(publish.stderr)
  if (publish.exitCode !== 0) {
    throw new Error(`${publishScript} failed with exit code ${publish.exitCode}`)
  }

  const payload = parseLastJsonObject(publish.stdout)
  const cidV0 = String(payload.cid_v0 ?? '')
  const cidV1 = String(payload.cid_v1 ?? '')
  if (!cidV0 || !cidV1 || cidV0 === 'null' || cidV1 === 'null') {
    throw new Error(`Failed to extract IPFS CIDs from publish result: ${JSON.stringify(payload)}`)
  }

  await appendGithubOutput('ipfs_cid_v0', cidV0, env)
  await appendGithubOutput('ipfs_cid_v1', cidV1, env)
  await appendGithubOutput('url', `https://${cidV1}.ipfs.aleph.sh`, env)

  let itemHash = ''
  if (pin) {
    const pinResult = await runCapture(alephBin, ['file', 'pin', cidV0], { cwd: projectDir })
    if (pinResult.stdout) process.stdout.write(pinResult.stdout)
    if (pinResult.stderr) process.stderr.write(pinResult.stderr)
    if (pinResult.exitCode !== 0) {
      throw new Error(`aleph file pin ${cidV0} failed with exit code ${pinResult.exitCode}`)
    }
    const pinPayload = parseLastJsonObject(pinResult.stdout)
    itemHash = String(pinPayload.item_hash ?? '')
    if (!itemHash) {
      throw new Error(`Aleph pin response did not include item_hash: ${JSON.stringify(pinPayload)}`)
    }
    await appendGithubOutput('item_hash', itemHash, env)
    await waitForAlephMessage(itemHash, env)
  }

  await appendGithubSummary([
    '## Shared Site Runner',
    '',
    `- Site directory: \`${siteDirectory}\``,
    `- IPFS CID v0: \`${cidV0}\``,
    `- IPFS CID v1: \`${cidV1}\``,
    `- Aleph item hash: \`${itemHash}\``,
  ], env)
}

export async function runDomainLinkMode(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const projectDir = optionalEnv('ALEPH_SITE_PROJECT_DIR', process.cwd(), env)
  const domain = requiredEnv('ALEPH_SITE_DOMAIN', env)
  const itemHash = requiredEnv('ALEPH_SITE_ITEM_HASH', env)
  const catchAllPath = optionalEnv('ALEPH_SITE_DOMAIN_CATCH_ALL_PATH', '/index.html', env)
  const alephBin = optionalEnv('ALEPH_SITE_ALEPH_BIN', 'aleph', env)

  const detach = await runCapture(alephBin, ['domain', 'detach', domain, '--no-ask'], { cwd: projectDir })
  if (detach.stdout) process.stdout.write(detach.stdout)
  if (detach.stderr) process.stderr.write(detach.stderr)

  const attach = await runCapture(alephBin, ['domain', 'attach', domain, '--item-hash', itemHash, '--catch-all-path', catchAllPath, '--no-ask'], { cwd: projectDir })
  if (attach.stdout) process.stdout.write(attach.stdout)
  if (attach.stderr) process.stderr.write(attach.stderr)
  if (attach.exitCode !== 0) {
    throw new Error(`aleph domain attach ${domain} failed with exit code ${attach.exitCode}`)
  }

  await appendGithubOutput('domain', domain, env)
  await appendGithubOutput('item_hash', itemHash, env)
  await appendGithubOutput('url', `https://${domain}`, env)

  await appendGithubSummary([
    '## Shared Site Runner',
    '',
    `- Linked domain: \`${domain}\``,
    `- Aleph item hash: \`${itemHash}\``,
    `- Catch-all path: \`${catchAllPath}\``,
  ], env)
}

export async function runProbeMode(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const addrs = mergedAddrs(env)
  if (addrs.length === 0) throw new Error('No relay probe or browser bootstrap multiaddrs were supplied.')
  const workdir = requiredEnv('ALEPH_SITE_PROBE_WORKDIR', env)
  const scriptPath = requiredEnv('ALEPH_SITE_PROBE_SCRIPT', env)
  const nodeBin = optionalEnv('ALEPH_SITE_NODE', 'node', env)

  const result = await runCapture(nodeBin, [scriptPath, ...addrs], { cwd: workdir })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.exitCode !== 0) {
    throw new Error(`relay probe failed with exit code ${result.exitCode}`)
  }

  const rows = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
  if (rows.length === 0) throw new Error('Relay probe produced no JSON output.')
  if (rows.some((row) => row.ok !== true)) throw new Error('At least one relay protocol probe failed.')

  await appendGithubOutput('ok', 'true', env)
  await appendGithubOutput('json', result.stdout.trim(), env)
  await appendGithubOutput('merged_multiaddrs_json', JSON.stringify(addrs), env)
}

export async function runBootstrapEnvMode(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const raw = env.BROWSER_BOOTSTRAP_MULTIADDRS_JSON ?? '[]'
  const addrs = JSON.parse(raw)
    .filter((value: unknown): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value: string) => value.trim())
  const csv = addrs.join(',')

  await appendGithubOutput('json', JSON.stringify(addrs), env)
  await appendGithubOutput('csv', csv, env)
  await appendGithubOutput('count', String(addrs.length), env)
  await appendGithubOutput('available', addrs.length > 0 ? 'true' : 'false', env)
}

export async function runSiteMode(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const mode = optionalEnv('ALEPH_VM_MODE', 'site-publish', env)
  if (mode === 'site-publish') return await runSitePublishMode(env)
  if (mode === 'site-domain-link') return await runDomainLinkMode(env)
  if (mode === 'relay-probe') return await runProbeMode(env)
  if (mode === 'bootstrap-env') return await runBootstrapEnvMode(env)
  throw new Error(`Unsupported ALEPH_VM_MODE "${mode}" in shared site runner.`)
}
