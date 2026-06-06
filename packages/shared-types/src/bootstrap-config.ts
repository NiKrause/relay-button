import type { PortMapping } from './runtime'

export type VmBootstrapConfigStatus = 'pending' | 'applied' | 'expired' | 'failed'

export interface VmBootstrapConfigRuntime {
  publicIpv4: string
  publicIpv6?: string | null
  proxyUrl?: string | null
  mappedPorts: Record<string, PortMapping>
}

export interface VmBootstrapConfigBootstrap {
  registrationId?: string | null
  ownerAuthorizationBase64?: string | null
}

export interface VmBootstrapConfigRecord {
  deploymentToken: string
  profile: string
  ownerAddress: string
  instanceItemHash: string
  createdAt: string
  expiresAt: string
  status: VmBootstrapConfigStatus
  runtime: VmBootstrapConfigRuntime
  bootstrap?: VmBootstrapConfigBootstrap | null
}

export type VmBootstrapConfigAggregate = Record<string, VmBootstrapConfigRecord>
