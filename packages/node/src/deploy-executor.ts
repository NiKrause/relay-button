import { createHash } from 'node:crypto'
import net from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'

import {
  cleanupFailedDeployment,
  configureUcGoPeer,
  createInstanceContent,
  deployInstance,
  ensureInstancePortForwards,
  fetchCrns,
  fetchUcGoPeerMetadata,
  notifyCrnAllocation,
  rankCandidateCrns,
  verifyUcGoPeerReachability,
  waitForDeploymentResult,
  waitForSetupEndpoint,
  waitForVmRuntime
} from '../../core/src/index.ts'
import type {
  CrnRecord,
  DeploymentInspectionResult,
  MessageHasher,
  MessageSigner,
  RootfsManifest
} from '@shared-aleph/shared-types'

import type { DeployConfigurationResult, DeployOutputResult } from './deploy-outputs.ts'
import type { DeployPlan } from './deploy-plan.ts'
import { createPrivateKeyIdentity } from './signer.ts'

export interface DeployExecutorDependencies {
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  tcpProbe?: (host: string, port: number, timeoutMs?: number) => Promise<{ ok: boolean | null; error?: string }>
  signer?: MessageSigner
  sender?: string
  hasher?: MessageHasher
  manifest?: RootfsManifest | null
  log?: (message: string) => void
}

function defaultHasher(payload: string): string {
  return createHash('sha256').update(payload).digest('hex')
}

async function defaultTcpProbe(host: string, port: number, timeoutMs = 5000): Promise<{ ok: boolean; error?: string }> {
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host, port: Number(port) })
    const finalize = (result: { ok: boolean; error?: string }) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(result)
    }

    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finalize({ ok: true }))
    socket.once('timeout', () => finalize({ ok: false, error: `timeout after ${timeoutMs}ms` }))
    socket.once('error', (error) => finalize({ ok: false, error: error.message }))
  })
}

function diagnosticsFromInspection(result: DeploymentInspectionResult, plan: DeployPlan) {
  if (result.status === 'processed') {
    return {
      state: 'aleph-processed',
      timedOut: false,
      reason: 'Deployment message processed by Aleph.'
    }
  }

  if (result.status === 'rejected') {
    return {
      state: 'aleph-rejected',
      timedOut: false,
      reason: result.rejectionReason ?? 'Aleph rejected the deployment.'
    }
  }

  return {
    state: 'aleph-processing-timeout',
    timedOut: true,
    reason: `Deployment remained ${result.status} after ${plan.waitAttempts} poll attempt(s).`
  }
}

function mergeVerificationState(args: {
  inspection: DeploymentInspectionResult
  runtime?: DeployOutputResult['runtime']
}) {
  const runtimeState = args.runtime?.diagnostics?.state ?? null
  return {
    ok: args.inspection.status === 'processed',
    state: runtimeState ?? args.inspection.status,
    rejectionReason: args.inspection.rejectionReason,
    references: args.inspection.references
  }
}

async function candidateCrnsForPlan(plan: DeployPlan, fetchImpl: typeof fetch): Promise<CrnRecord[]> {
  const crns = await fetchCrns({
    url: plan.crnListUrl,
    fetch: fetchImpl
  })

  if (plan.crnHash) {
    const explicit = crns.find((crn) => crn.hash === plan.crnHash)
    return explicit ? [explicit] : []
  }

  return (await rankCandidateCrns(crns, {
    fetch: fetchImpl,
    preferredCountryCode: plan.preferredCountryCode,
    geoLimit: plan.geoCrnLimit
  })).slice(0, Math.max(1, plan.maxCrnAttempts))
}

function buildManifest(plan: DeployPlan, manifest: RootfsManifest | null | undefined): RootfsManifest {
  return (
    manifest ?? {
      version: '1.0',
      profile: plan.profile,
      rootfsItemHash: plan.rootfsItemHash,
      rootfsSizeMiB: plan.rootfsSizeMiB,
      rootfsInstallStrategy: 'thin',
      requiredPortForwards: plan.requiredPorts,
      createdAt: new Date().toISOString(),
      notes: 'Synthetic manifest assembled by the shared deploy executor.'
    }
  )
}

export async function executeDeployPlan(
  plan: DeployPlan,
  dependencies: DeployExecutorDependencies = {}
): Promise<DeployOutputResult> {
  const fetchImpl = dependencies.fetch ?? globalThis.fetch?.bind(globalThis)
  if (typeof fetchImpl !== 'function') {
    throw new Error('A fetch implementation is required to execute the shared deploy plan.')
  }

  const hasher = dependencies.hasher ?? defaultHasher
  const tcpProbe = dependencies.tcpProbe ?? defaultTcpProbe
  const sleepImpl = dependencies.sleep ?? ((ms) => sleep(ms).then(() => undefined))
  const log = dependencies.log ?? ((message: string) => console.log(message))
  const identity =
    dependencies.sender && dependencies.signer
      ? { address: dependencies.sender, signer: dependencies.signer }
      : await createPrivateKeyIdentity(plan.privateKey)

  const candidateCrns = await candidateCrnsForPlan(plan, fetchImpl)
  if (candidateCrns.length === 0) {
    throw new Error('No compatible CRN was available for deployment.')
  }

  log(`[deploy] profile=${plan.profile} sender=${identity.address}`)
  log(
    `[deploy] candidate CRNs=${candidateCrns
      .map((crn) => `${crn.name ?? crn.hash}:${crn.hash}`)
      .join(', ')}`
  )

  let lastError: Error | null = null

  for (const [candidateIndex, candidateCrn] of candidateCrns.entries()) {
    log(
      `[deploy] attempting CRN ${candidateIndex + 1}/${candidateCrns.length}: ${candidateCrn.name ?? candidateCrn.hash} (${candidateCrn.hash})`
    )
    const content = createInstanceContent({
      address: identity.address,
      name: plan.name,
      sshPublicKey: plan.sshPublicKey,
      rootfsItemHash: plan.rootfsItemHash,
      rootfsSizeMiB: plan.rootfsSizeMiB,
      vcpus: plan.vcpus,
      memoryMiB: plan.memoryMiB,
      seconds: plan.seconds,
      rootfsVersion: plan.rootfsVersion || 'custom-rootfs',
      crnHash: candidateCrn.hash,
      deployer: 'shared-aleph-tooling'
    })

    const deployment = await deployInstance({
      sender: identity.address,
      content,
      hasher,
      signer: identity.signer,
      fetch: fetchImpl,
      apiHost: plan.apiHost,
      channel: plan.channel,
      sync: true
    })

    log(`[deploy] broadcasted INSTANCE message ${deployment.itemHash} on ${candidateCrn.name ?? candidateCrn.hash}`)

    const inspection = await waitForDeploymentResult(deployment.itemHash, {
      rootfsRef: plan.rootfsItemHash,
      apiHost: plan.apiHost,
      fetch: fetchImpl,
      attempts: plan.waitAttempts,
      delayMs: plan.waitDelayMs,
      sleep: sleepImpl,
      onAttempt: (result, attempt, attempts) => {
        log(
          `[deploy] Aleph processing ${attempt}/${attempts} for ${deployment.itemHash}: status=${result.status}${
            result.rejectionReason ? ` reason=${result.rejectionReason}` : ''
          }`
        )
      }
    })

    if (inspection.status === 'rejected') {
      log(
        `[deploy] CRN ${candidateCrn.name ?? candidateCrn.hash} rejected deployment ${deployment.itemHash}: ${
          inspection.rejectionReason ?? 'no additional reason'
        }`
      )
      lastError = new Error(
        `Deployment on ${candidateCrn.name ?? candidateCrn.hash} was rejected: ${inspection.rejectionReason ?? 'no additional rejection reason from Aleph'}.`
      )
      continue
    }

    if (inspection.status !== 'processed') {
      log(
        `[deploy] deployment ${deployment.itemHash} on ${candidateCrn.name ?? candidateCrn.hash} did not become processed; cleaning up`
      )
      await cleanupFailedDeployment({
        sender: identity.address,
        instanceItemHash: deployment.itemHash,
        reason: `Deployment message stayed ${inspection.status}`,
        signer: identity.signer,
        hasher,
        fetch: fetchImpl,
        channel: plan.channel,
        apiHost: plan.apiHost
      })
      lastError = new Error(
        `Deployment message ${deployment.itemHash} on ${candidateCrn.name ?? candidateCrn.hash} stayed ${inspection.status} without becoming processed.`
      )
      continue
    }

    let portForwarding: DeployOutputResult['portForwarding'] = null
    if (plan.publishPortForwards && plan.requiredPorts.length > 0) {
      log(`[deploy] publishing required port-forward aggregate for ${deployment.itemHash}`)
      const aggregate = await ensureInstancePortForwards({
        sender: identity.address,
        instanceItemHash: deployment.itemHash,
        manifest: buildManifest(plan, dependencies.manifest),
        signer: identity.signer,
        hasher,
        fetch: fetchImpl,
        channel: plan.channel,
        apiHost: plan.apiHost,
        sync: true
      })

      portForwarding = {
        aggregateItemHash: aggregate.aggregateItemHash,
        aggregateStatus: aggregate.aggregateStatus
      }
      log(
        `[deploy] port-forward aggregate published: item_hash=${aggregate.aggregateItemHash} status=${aggregate.aggregateStatus}`
      )
    }

    log(`[deploy] waiting for runtime networking on ${candidateCrn.name ?? candidateCrn.hash}`)
    const runtime = await waitForVmRuntime({
      itemHash: deployment.itemHash,
      fetch: fetchImpl,
      crnHash: candidateCrn.hash,
      crns: candidateCrns,
      crnListUrl: plan.crnListUrl,
      attempts: plan.runtimeAttempts,
      delayMs: plan.runtimeDelayMs,
      sleep: sleepImpl,
      onAttempt: (runtimeAttempt, attempt, attempts) => {
        log(
          `[deploy] runtime ${attempt}/${attempts} for ${deployment.itemHash}: state=${
            runtimeAttempt.diagnostics?.state ?? 'unknown'
          } host=${runtimeAttempt.hostIpv4 ?? '-'} mapped_ports=${
            Object.keys(runtimeAttempt.mappedPorts ?? {}).length
          }`
        )
      }
    }).catch(() => null)

    const runtimeMetadata: NonNullable<DeployOutputResult['runtime']> = runtime
      ? {
          allocation: runtime.allocation,
          hostIpv4: runtime.hostIpv4,
          ipv6: runtime.ipv6,
          proxyUrl: runtime.proxyUrl,
          sshCommand: runtime.sshCommand,
          setupHealth: null,
          mappedPorts: runtime.mappedPorts,
          diagnostics: runtime.diagnostics,
          selectedCrn: runtime.selectedCrn ?? { hash: candidateCrn.hash, name: candidateCrn.name ?? '' }
        }
      : {
          allocation: null,
          hostIpv4: null,
          ipv6: null,
          proxyUrl: null,
          sshCommand: null,
          setupHealth: null,
          mappedPorts: {},
          diagnostics: diagnosticsFromInspection(inspection, plan),
          selectedCrn: { hash: candidateCrn.hash, name: candidateCrn.name ?? '' }
        }

    if (!runtime?.hostIpv4 || Object.keys(runtime?.mappedPorts ?? {}).length === 0) {
      log(
        `[deploy] processed deployment ${deployment.itemHash} never exposed usable runtime networking on ${
          candidateCrn.name ?? candidateCrn.hash
        }; cleaning up`
      )
      await cleanupFailedDeployment({
        sender: identity.address,
        instanceItemHash: deployment.itemHash,
        reason: `Processed deployment never exposed runtime networking${runtime?.diagnostics?.state ? ` (${runtime.diagnostics.state})` : ''}`,
        signer: identity.signer,
        hasher,
        fetch: fetchImpl,
        channel: plan.channel,
        apiHost: plan.apiHost
      })
      lastError = new Error(
        `Deployment ${deployment.itemHash} on ${candidateCrn.name ?? candidateCrn.hash} was processed but did not expose runtime networking in time.${runtime?.diagnostics?.reason ? ` ${runtime.diagnostics.reason}` : ''}`
      )
      continue
    }

    let configuration: DeployOutputResult['configuration'] = null
    let verification: DeployOutputResult['verification'] = null

    if (runtime.selectedCrn?.address) {
      log(`[deploy] notifying CRN allocation endpoint ${runtime.selectedCrn.address}`)
      await notifyCrnAllocation({
        crnUrl: runtime.selectedCrn.address,
        itemHash: deployment.itemHash,
        fetch: fetchImpl
      }).catch(() => null)
    }

    if (runtime.hostIpv4 && plan.autoConfigure !== false && plan.profile === 'uc-go-peer') {
      const mappedPorts = runtime.mappedPorts ?? {}
      const setupPort = mappedPorts['80']?.host ?? null
      const tcpPort = mappedPorts['9095']?.host ?? null
      const wsPort = mappedPorts['9097']?.host ?? tcpPort
      const udpPort = mappedPorts['9095']?.udp === true ? mappedPorts['9095']?.host ?? null : null
      const proxyUrl = plan.enableCaddyProxy ? runtime.proxyUrl ?? null : null

      if (setupPort && runtime.hostIpv4) {
        log(`[deploy] waiting for temporary setup endpoint on http://${runtime.hostIpv4}:${setupPort}/health`)
        const setupHealth = await waitForSetupEndpoint({
          hostIpv4: runtime.hostIpv4,
          setupPort,
          fetch: fetchImpl,
          attempts: plan.setupAttempts,
          delayMs: plan.setupDelayMs,
          httpTimeoutMs: plan.httpTimeoutMs,
          sleep: sleepImpl,
          onAttempt: (result, attempt, attempts) => {
            log(
              `[deploy] setup endpoint ${attempt}/${attempts}: ok=${result.ok} status=${
                result.status ?? '-'
              } error=${result.error ?? '-'}`
            )
          }
        })

        runtimeMetadata.setupHealth = setupHealth
        if (!setupHealth.ok) {
          log(`[deploy] setup endpoint never became reachable; cleaning up ${deployment.itemHash}`)
          await cleanupFailedDeployment({
            sender: identity.address,
            instanceItemHash: deployment.itemHash,
            reason: 'Temporary setup endpoint never became reachable',
            signer: identity.signer,
            hasher,
            fetch: fetchImpl,
            channel: plan.channel,
            apiHost: plan.apiHost
          })
          lastError = new Error(`Temporary setup endpoint did not become reachable at http://${runtime.hostIpv4}:${setupPort}/health.`)
          continue
        }

        log(`[deploy] calling guest /configure for ${deployment.itemHash}`)
        const configureResult = await configureUcGoPeer({
          hostIpv4: runtime.hostIpv4,
          publicIpv6: runtime.ipv6,
          setupPort,
          tcpPort,
          wsPort,
          udpPort,
          quicPort: udpPort,
          webrtcPort: udpPort,
          proxyUrl,
          fetch: fetchImpl,
          timeoutMs: plan.configureTimeoutMs
        })

        log(`[deploy] polling guest /metadata until ready`)
        const metadataResult = await fetchUcGoPeerMetadata({
          hostIpv4: runtime.hostIpv4,
          setupPort,
          fetch: fetchImpl,
          attempts: plan.metadataAttempts,
          delayMs: plan.metadataDelayMs,
          timeoutMs: plan.metadataTimeoutMs,
          sleep: sleepImpl,
          onAttempt: (_payload, ready, attempt, attempts) => {
            log(`[deploy] guest metadata ${attempt}/${attempts}: ready=${ready}`)
          }
        })

        configuration = {
          ...(configureResult && typeof configureResult === 'object' ? (configureResult as Record<string, unknown>) : {}),
          metadata:
            metadataResult && typeof metadataResult === 'object'
              ? ((metadataResult as { metadata?: unknown }).metadata ?? null) as DeployConfigurationResult['metadata']
              : null
        }

        if (plan.verifyReachability !== false) {
          let latestVerification: DeployOutputResult['verification'] = null
          for (let attempt = 0; attempt < plan.verifyAttempts; attempt += 1) {
            log(`[deploy] reachability verification ${attempt + 1}/${plan.verifyAttempts}`)
            latestVerification = await verifyUcGoPeerReachability({
              hostIpv4: runtime.hostIpv4,
              mappedPorts,
              proxyUrl,
              verifyProxyHttp: !plan.enableCaddyProxy,
              skipInternalPorts: plan.enableCaddyProxy ? ['80'] : ['80', '443'],
              tcpTimeoutMs: plan.tcpTimeoutMs,
              httpTimeoutMs: plan.httpTimeoutMs,
              fetch: fetchImpl,
              tcpProbe
            })
            if (latestVerification?.ok) {
              log(`[deploy] reachability verification succeeded`)
              break
            }
            if (attempt < plan.verifyAttempts - 1) {
              log(`[deploy] reachability verification not ready yet; sleeping ${plan.verifyDelayMs}ms`)
              await sleepImpl(plan.verifyDelayMs)
            }
          }
          verification = latestVerification
        }
      }
    }

    verification =
      verification ??
      mergeVerificationState({
        inspection,
        runtime: runtimeMetadata
      })

    return {
      sender: identity.address,
      itemHash: deployment.itemHash,
      httpStatus: deployment.httpStatus,
      status: inspection.status,
      selectedCrn: { hash: candidateCrn.hash, name: candidateCrn.name ?? '' },
      portForwarding,
      runtime: runtimeMetadata,
      configuration,
      verification
    }
  }

  log(`[deploy] no candidate CRN succeeded`)
  throw lastError ?? new Error('No compatible CRN deployment attempt succeeded.')
}
