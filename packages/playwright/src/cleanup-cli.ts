#!/usr/bin/env node
/**
 * Standalone Aleph Playwright runner cleanup CLI (issue #30 post-merge cleanup).
 *
 * Erases one exact INSTANCE on its CRN (best effort), broadcasts a mandatory
 * owner-signed FORGET, verifies deletion on the API replicas and the scheduler,
 * and writes evidence JSON. Replaces the composite action's cleanup-exact.mjs
 * and the per-consumer copies (e.g. simple-todo scripts/cleanup-aleph-instance.mjs)
 * with a single published implementation:
 *
 *   npx --yes --package=@le-space/playwright --package=ethers playwright-runner-cleanup \
 *     --instance-hash <64-hex> [--evidence-path <file>] [--api-hosts <csv>] [--reason <text>]
 *
 * Environment fallbacks: ALEPH_PLAYWRIGHT_INSTANCE_HASH, ALEPH_PRIVATE_KEY (required),
 * ALEPH_VM_API_HOSTS, EVIDENCE_PATH. Appends to GITHUB_OUTPUT / GITHUB_STEP_SUMMARY
 * when present. Signing uses ethers when available, falling back to viem.
 */
import { createHash } from 'node:crypto'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import process from 'node:process'

import { eraseInstanceOnCrn, forgetAlephMessages } from '@le-space/core'

import { resolveAlephApiHosts, waitForAlephInstanceDeletion } from './aleph-instance.ts'

interface CleanupSigner {
  address: string
  sign: (payload: string) => Promise<string>
}

export function parseCleanupCliArgs(argv: readonly string[], env: NodeJS.ProcessEnv): {
  instanceHash: string
  apiHosts: string[]
  evidencePath: string
  reason: string
} {
  const flags = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument.startsWith('--')) continue
    const equals = argument.indexOf('=')
    if (equals > -1) {
      flags.set(argument.slice(2, equals), argument.slice(equals + 1))
    } else {
      const value = argv[index + 1]
      if (value == null || value.startsWith('--')) throw new Error(`Missing value for --${argument.slice(2)}`)
      flags.set(argument.slice(2), value)
      index += 1
    }
  }

  const instanceHash = (flags.get('instance-hash') ?? env.ALEPH_PLAYWRIGHT_INSTANCE_HASH ?? '').trim()
  if (!/^[a-f0-9]{64}$/iu.test(instanceHash)) {
    throw new Error('Cleanup requires one exact INSTANCE hash (--instance-hash or ALEPH_PLAYWRIGHT_INSTANCE_HASH)')
  }
  const hostCandidates = (flags.get('api-hosts') ?? env.ALEPH_VM_API_HOSTS ?? '')
    .split(/[\s,]+/u)
    .filter(Boolean)
  return {
    instanceHash,
    apiHosts: resolveAlephApiHosts(hostCandidates.length > 0 ? hostCandidates : undefined),
    evidencePath:
      (flags.get('evidence-path') ?? env.EVIDENCE_PATH ?? '').trim() ||
      `playwright-runner-cleanup-${instanceHash.slice(0, 12)}.json`,
    reason: (flags.get('reason') ?? '').trim() || `Ephemeral Playwright runner cleanup for ${instanceHash}`,
  }
}

interface EthersWalletModule {
  Wallet: new (privateKey: string) => {
    getAddress(): Promise<string>
    signMessage(payload: string): Promise<string>
  }
}

interface ViemAccountsModule {
  privateKeyToAccount: (privateKey: `0x${string}`) => {
    address: string
    signMessage(args: { message: string }): Promise<string>
  }
}

/**
 * ethers and viem are optional signing backends, intentionally not declared as
 * dependencies. The specifier is typed as string so the type checker does not
 * try to resolve modules that may be absent at build time.
 */
function importOptional(specifier: string): Promise<unknown> {
  return import(specifier)
}

async function createSigner(privateKey: string): Promise<CleanupSigner> {
  const normalizedKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`
  try {
    const { Wallet } = (await importOptional('ethers')) as EthersWalletModule
    const wallet = new Wallet(normalizedKey)
    return { address: await wallet.getAddress(), sign: (payload) => wallet.signMessage(payload) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ERR_MODULE_NOT_FOUND') throw error
  }
  try {
    const { privateKeyToAccount } = (await importOptional('viem/accounts')) as ViemAccountsModule
    const account = privateKeyToAccount(normalizedKey as `0x${string}`)
    return { address: account.address, sign: (payload) => account.signMessage({ message: payload }) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ERR_MODULE_NOT_FOUND') throw error
  }
  throw new Error('playwright-runner-cleanup needs either "ethers" or "viem" to sign the FORGET message')
}

export async function runCleanupCli(argv: readonly string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const options = parseCleanupCliArgs(argv, env)
  const privateKey = env.ALEPH_PRIVATE_KEY?.trim()
  if (!privateKey) throw new Error('ALEPH_PRIVATE_KEY is required')
  const identity = await createSigner(privateKey)
  const signer = (_sender: string, payload: string) => identity.sign(payload)
  const fetchImpl = globalThis.fetch.bind(globalThis)

  let erase: Awaited<ReturnType<typeof eraseInstanceOnCrn>> | undefined
  for (const apiHost of options.apiHosts) {
    try {
      erase = await eraseInstanceOnCrn({
        sender: identity.address,
        signer,
        instanceHash: options.instanceHash,
        fetch: fetchImpl,
        apiHost,
      })
      break
    } catch {
      // Best effort: the owner-signed FORGET and verification below are mandatory.
    }
  }

  let forget: Awaited<ReturnType<typeof forgetAlephMessages>> | null = null
  for (const apiHost of options.apiHosts) {
    try {
      forget = await forgetAlephMessages({
        sender: identity.address,
        hashes: [options.instanceHash],
        reason: options.reason,
        signer,
        hasher: (content) => createHash('sha256').update(content).digest('hex'),
        fetch: fetchImpl,
        apiHost,
        sync: true,
      })
      if (forget.status === 'rejected') throw new Error('FORGET rejected')
      break
    } catch {
      forget = null
    }
  }
  if (!forget) throw new Error(`Owner-signed FORGET failed for ${options.instanceHash}`)

  const verification = await waitForAlephInstanceDeletion({
    instanceHash: options.instanceHash,
    apiHosts: options.apiHosts,
    fetch: fetchImpl,
  })

  await mkdir(dirname(options.evidencePath) || '.', { recursive: true })
  await writeFile(
    options.evidencePath,
    `${JSON.stringify(
      {
        instanceHash: options.instanceHash,
        owner: identity.address,
        apiHosts: options.apiHosts,
        erase,
        forget: forget.itemHash,
        verification,
      },
      null,
      2,
    )}\n`,
  )
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `evidence_path=${options.evidencePath}\n`)
  if (env.GITHUB_STEP_SUMMARY) {
    await appendFile(
      env.GITHUB_STEP_SUMMARY,
      `\n## Aleph Playwright cleanup\n\n- Exact INSTANCE: \`${options.instanceHash}\`\n- Runtime erase: \`${erase?.status ?? 'unavailable'}\`\n- Owner FORGET: \`${forget.status}\`\n- Verification: ${verification}\n`,
    )
  }
}

const invokedDirectly = process.argv[1]?.endsWith('cleanup-cli.ts') || process.argv[1]?.endsWith('cleanup-cli.js') || process.argv[1]?.endsWith('playwright-runner-cleanup')
if (invokedDirectly) {
  runCleanupCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
