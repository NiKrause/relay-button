import type {
  CrnRecord,
  InstanceAllocation,
  PortMapping,
  RuntimeDiagnostics
} from '@shared-aleph/shared-types'

import { appendGithubOutput, appendGithubSummary } from './github-outputs.ts'

export interface DeployMetadataResult {
  peer_id?: string
  probe_multiaddrs?: string[]
  browser_bootstrap_multiaddrs?: string[]
  [key: string]: unknown
}

export interface DeployConfigurationResult {
  metadata?: DeployMetadataResult | null
  [key: string]: unknown
}

export interface DeployOutputResult {
  sender?: string
  itemHash?: string
  httpStatus?: number
  status?: string
  selectedCrn?: {
    hash?: string
    name?: string
  } | null
  portForwarding?: {
    aggregateItemHash?: string
    aggregateStatus?: string
  } | null
  runtime?: {
    allocation?: InstanceAllocation | null
    hostIpv4?: string | null
    ipv6?: string | null
    proxyUrl?: string | null
    sshCommand?: string | null
    setupHealth?: {
      ok?: boolean
      status?: number
      url?: string
      error?: string
    } | null
    mappedPorts?: Record<string, PortMapping>
    diagnostics?: RuntimeDiagnostics | null
    selectedCrn?: CrnRecord | null
  } | null
  configuration?: DeployConfigurationResult | null
  verification?: {
    ok?: boolean
    [key: string]: unknown
  } | null
}

export async function emitDeployOutputs(
  deployResult: DeployOutputResult,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ runtimeJson: string; verificationJson: string }> {
  const runtime = deployResult?.runtime ?? null
  const selectedCrn = runtime?.selectedCrn ?? deployResult?.selectedCrn ?? null
  const runtimeJson = JSON.stringify(runtime ?? {})
  const mappedPortsJson = JSON.stringify(runtime?.mappedPorts ?? {})
  const portForwardingJson = JSON.stringify(deployResult?.portForwarding ?? {})
  const configurationJson = JSON.stringify(deployResult?.configuration ?? {})
  const verificationJson = JSON.stringify(deployResult?.verification ?? {})
  const probeMultiaddrsJson = JSON.stringify(deployResult?.configuration?.metadata?.probe_multiaddrs ?? [])
  const browserBootstrapMultiaddrsJson = JSON.stringify(
    deployResult?.configuration?.metadata?.browser_bootstrap_multiaddrs ?? []
  )
  const relayPeerId = deployResult?.configuration?.metadata?.peer_id ?? ''
  const deploymentStatus = deployResult?.status ?? ''

  await appendGithubOutput('deployer_address', deployResult?.sender ?? '', env)
  await appendGithubOutput('instance_item_hash', deployResult?.itemHash ?? '', env)
  await appendGithubOutput('instance_status', deploymentStatus, env)
  await appendGithubOutput('instance_http_status', deployResult?.httpStatus ?? '', env)
  await appendGithubOutput('port_forward_aggregate_item_hash', deployResult?.portForwarding?.aggregateItemHash ?? '', env)
  await appendGithubOutput('port_forward_status', deployResult?.portForwarding?.aggregateStatus ?? '', env)
  await appendGithubOutput('crn_hash', selectedCrn?.hash ?? '', env)
  await appendGithubOutput('crn_name', selectedCrn?.name ?? '', env)
  await appendGithubOutput('crn_url', runtime?.allocation?.crnUrl ?? '', env)
  await appendGithubOutput('host_ipv4', runtime?.hostIpv4 ?? '', env)
  await appendGithubOutput('ipv6', runtime?.ipv6 ?? '', env)
  await appendGithubOutput('web_proxy_url', runtime?.proxyUrl ?? '', env)
  await appendGithubOutput('ssh_command', runtime?.sshCommand ?? '', env)
  await appendGithubOutput('setup_endpoint_ok', runtime?.setupHealth?.ok ?? '', env)
  await appendGithubOutput('mapped_ports_json', mappedPortsJson, env)
  await appendGithubOutput('configuration_json', configurationJson, env)
  await appendGithubOutput('relay_peer_id', relayPeerId, env)
  await appendGithubOutput('probe_multiaddrs_json', probeMultiaddrsJson, env)
  await appendGithubOutput('browser_bootstrap_multiaddrs_json', browserBootstrapMultiaddrsJson, env)
  await appendGithubOutput('verification_json', verificationJson, env)
  await appendGithubOutput('verification_ok', deployResult?.verification?.ok ?? '', env)
  await appendGithubOutput('port_forwarding_json', portForwardingJson, env)
  await appendGithubOutput('runtime_json', runtimeJson, env)

  await appendGithubSummary([
    '## Aleph VM deployment',
    '',
    `- Instance item hash: \`${deployResult?.itemHash ?? 'unknown'}\``,
    `- Deployment status: \`${deploymentStatus || 'unknown'}\``,
    `- Port-forward aggregate status: \`${deployResult?.portForwarding?.aggregateStatus ?? 'unknown'}\``,
    `- CRN: \`${selectedCrn?.name ?? selectedCrn?.hash ?? 'unknown'}\``,
    `- CRN URL: \`${runtime?.allocation?.crnUrl ?? 'unknown'}\``,
    `- Host IPv4: \`${runtime?.hostIpv4 ?? 'unknown'}\``,
    `- IPv6: \`${runtime?.ipv6 ?? 'unknown'}\``,
    `- Web proxy URL: \`${runtime?.proxyUrl ?? 'unknown'}\``,
    `- Relay peer ID: \`${relayPeerId || 'unknown'}\``,
    `- SSH command: \`${runtime?.sshCommand ?? 'unknown'}\``,
    `- Setup endpoint reachable before configure: \`${runtime?.setupHealth?.ok ?? 'unknown'}\``,
    `- Runtime diagnostics: \`${runtime?.diagnostics?.state ?? 'unknown'}${runtime?.diagnostics?.timedOut ? ' (timed out)' : ''}\``,
    `- Runtime reason: \`${runtime?.diagnostics?.reason ?? 'none'}\``,
    `- Verification ok: \`${deployResult?.verification?.ok ?? 'unknown'}\``,
    '',
    '### Port mappings',
    '',
    '```json',
    mappedPortsJson,
    '```',
    '',
    '### Reachability checks',
    '',
    '```json',
    verificationJson,
    '```'
  ], env)

  return { runtimeJson, verificationJson }
}

export async function emitGeocodedCrnOutputs(
  geocodedCrns: unknown[],
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const payload = JSON.stringify(geocodedCrns)
  await appendGithubOutput('geocoded_crns_json', payload, env)
  await appendGithubOutput('geocoded_crn_count', geocodedCrns.length, env)
  await appendGithubSummary([
    '## Aleph geocoded CRNs',
    '',
    `- Geocoded CRNs: \`${geocodedCrns.length}\``
  ], env)
}
