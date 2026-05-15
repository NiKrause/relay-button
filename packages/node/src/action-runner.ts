import { pathToFileURL } from 'node:url'

import { listGeocodedCrns, retainSuccessfulDeployments } from '../../core/src/index.ts'

import { integerEnv, jsonEnv, optionalEnv, requiredEnv } from './env.ts'
import { emitDeployOutputs, emitGeocodedCrnOutputs } from './deploy-outputs.ts'
import { appendGithubOutput, appendGithubSummary, actionLog } from './github-outputs.ts'
import { executeDeployPlan } from './deploy-executor.ts'
import { parseDeployPlan } from './deploy-plan.ts'
import { createPrivateKeyIdentity, type PrivateKeyIdentity } from './signer.ts'

function parseOptionalJson<T>(raw: string | undefined): T | null {
  if (!raw || !raw.trim()) return null
  return JSON.parse(raw) as T
}

export function buildScaffoldDeployResult(env: NodeJS.ProcessEnv = process.env) {
  const profile = optionalEnv('ALEPH_VM_PROFILE', 'uc-go-peer', env)
  const itemHash = optionalEnv('ALEPH_VM_INSTANCE_ITEM_HASH', '', env)
  const status = optionalEnv('ALEPH_VM_INSTANCE_STATUS', itemHash ? 'processed' : 'unknown', env)

  return {
    sender: optionalEnv('ALEPH_VM_DEPLOYER_ADDRESS', '', env),
    itemHash,
    status,
    portForwarding: {
      aggregateItemHash: optionalEnv('ALEPH_VM_PORT_FORWARD_AGGREGATE_ITEM_HASH', '', env),
      aggregateStatus: optionalEnv('ALEPH_VM_PORT_FORWARD_STATUS', '', env)
    },
    runtime: {
      allocation: {
        crnUrl: optionalEnv('ALEPH_VM_CRN_URL', '', env)
      },
      hostIpv4: optionalEnv('ALEPH_VM_HOST_IPV4', '', env),
      ipv6: optionalEnv('ALEPH_VM_IPV6', '', env),
      proxyUrl: optionalEnv('ALEPH_VM_WEB_PROXY_URL', '', env),
      sshCommand: optionalEnv('ALEPH_VM_SSH_COMMAND', '', env),
      setupHealth: {
        ok: optionalEnv('ALEPH_VM_SETUP_ENDPOINT_OK', '', env) === 'true'
      },
      mappedPorts: parseOptionalJson<Record<string, unknown>>(env.ALEPH_VM_MAPPED_PORTS_JSON) ?? {},
      diagnostics: {
        state: 'scaffold',
        timedOut: false,
        reason: `Shared action runner scaffold for profile ${profile}`
      },
      selectedCrn: {
        hash: optionalEnv('ALEPH_VM_CRN_HASH', '', env),
        name: optionalEnv('ALEPH_VM_CRN_NAME', '', env)
      }
    },
    configuration: {
      metadata: {
        peer_id: optionalEnv('ALEPH_VM_RELAY_PEER_ID', '', env),
        probe_multiaddrs: parseOptionalJson<string[]>(env.ALEPH_VM_PROBE_MULTIADDRS_JSON) ?? [],
        browser_bootstrap_multiaddrs:
          parseOptionalJson<string[]>(env.ALEPH_VM_BROWSER_BOOTSTRAP_MULTIADDRS_JSON) ?? []
      }
    },
    verification: parseOptionalJson<Record<string, unknown>>(env.ALEPH_VM_VERIFICATION_JSON) ?? {
      ok: false,
      state: 'scaffold'
    }
  }
}

export async function runActionMode(
  env: NodeJS.ProcessEnv = process.env,
  hooks: {
    stdout?: (text: string) => void
    listGeocodedCrns?: typeof listGeocodedCrns
    deployExecutor?: typeof executeDeployPlan
    retainSuccessfulDeployments?: typeof retainSuccessfulDeployments
    createPrivateKeyIdentity?: (
      privateKey: string
    ) => Promise<PrivateKeyIdentity>
  } = {}
): Promise<void> {
  const mode = optionalEnv('ALEPH_VM_MODE', 'deploy', env)
  const stdout = hooks.stdout ?? ((text: string) => process.stdout.write(text))

  if (mode === 'list-crns') {
    if (!parseOptionalJson<unknown[]>(env.ALEPH_VM_GEOCRN_PAYLOAD_JSON) && typeof globalThis.fetch !== 'function') {
      throw new Error('A fetch implementation is required for list-crns mode when no CRN payload is pre-supplied.')
    }

    const payload =
      parseOptionalJson<unknown[]>(env.ALEPH_VM_GEOCRN_PAYLOAD_JSON) ??
      (await (hooks.listGeocodedCrns ?? listGeocodedCrns)({
        url: optionalEnv('ALEPH_VM_CRN_LIST_URL', undefined, env) || undefined,
        limit: Number(optionalEnv('ALEPH_VM_GEO_CRN_LIMIT', '30', env)),
        fetch: globalThis.fetch.bind(globalThis)
      }))
    await emitGeocodedCrnOutputs(payload, env)
    stdout(`${JSON.stringify(payload)}\n`)
    return
  }

  if (mode === 'retain-successful-deployments') {
    if (typeof globalThis.fetch !== 'function') {
      throw new Error('A fetch implementation is required for retain-successful-deployments mode.')
    }

    const identity = await (hooks.createPrivateKeyIdentity ?? createPrivateKeyIdentity)(
      requiredEnv('ALEPH_VM_PRIVATE_KEY', env)
    )
    const payload = await (hooks.retainSuccessfulDeployments ?? retainSuccessfulDeployments)({
      sender: identity.address,
      currentRecord: jsonEnv<unknown>('ALEPH_VM_RETENTION_CURRENT_RECORD_JSON', '{}', env),
      keepCount: integerEnv('ALEPH_VM_RETENTION_KEEP_COUNT', 2, env),
      extraForgetHashes: jsonEnv<string[]>('ALEPH_VM_RETENTION_EXTRA_FORGET_HASHES_JSON', '[]', env),
      signer: identity.signer,
      hasher: async (content) => {
        const { createHash } = await import('node:crypto')
        return createHash('sha256').update(content).digest('hex')
      },
      fetch: globalThis.fetch.bind(globalThis),
      channel: optionalEnv('ALEPH_VM_CHANNEL', 'TEST', env),
      apiHost: optionalEnv('ALEPH_VM_API_HOST', 'https://api2.aleph.im', env)
    })

    await appendGithubOutput('retention_result_json', JSON.stringify(payload), env)
    await appendGithubOutput('retention_forget_hashes_json', JSON.stringify(payload.forgetHashes ?? []), env)
    await appendGithubOutput('retention_pruned_count', payload.prunedRecords?.length ?? 0, env)
    await appendGithubOutput('retention_retained_count', payload.retainedRecords?.length ?? 0, env)
    await appendGithubSummary([
      '## Successful deployment retention',
      '',
      `- Keep count: \`${payload.keepCount}\``,
      `- Retained deployments: \`${payload.retainedRecords?.length ?? 0}\``,
      `- Pruned deployments: \`${payload.prunedRecords?.length ?? 0}\``,
      `- Forgotten hashes: \`${(payload.forgetHashes ?? []).length}\``
    ], env)
    stdout(`${JSON.stringify(payload)}\n`)
    return
  }

  if (mode !== 'deploy') {
    throw new Error(`Unsupported ALEPH_VM_MODE "${mode}" in shared action runner.`)
  }

  const providedDeployResult = parseOptionalJson<Record<string, unknown>>(env.ALEPH_VM_DEPLOY_RESULT_JSON)
  let deployResult = providedDeployResult
  if (!deployResult) {
    try {
      deployResult = await (hooks.deployExecutor ?? executeDeployPlan)(parseDeployPlan(env))
    } catch (error) {
      if (error instanceof Error && error.message.includes('Missing required environment variable')) {
        deployResult = buildScaffoldDeployResult(env)
      } else {
        throw error
      }
    }
  }

  await emitDeployOutputs(deployResult, env)
  await appendGithubOutput('action_runner_mode', mode, env)
  await appendGithubOutput('action_runner_profile', optionalEnv('ALEPH_VM_PROFILE', 'uc-go-peer', env), env)
  await appendGithubSummary([
    '',
    '### Shared Action Runner',
    '',
    `- Mode: \`${mode}\``,
    `- Profile: \`${optionalEnv('ALEPH_VM_PROFILE', 'uc-go-peer', env)}\``
  ], env)
  actionLog('notice', `Shared action runner executed in ${mode} mode for profile ${optionalEnv('ALEPH_VM_PROFILE', 'uc-go-peer', env)}.`)
  stdout(`${JSON.stringify(deployResult)}\n`)
}

export async function main(): Promise<void> {
  await runActionMode(process.env)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    actionLog('error', message)
    process.exitCode = 1
  })
}
