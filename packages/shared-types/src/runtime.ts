export interface PortMapping {
  host?: number
  tcp?: boolean
  udp?: boolean
}

export interface CrnSystemUsage {
  cpu?: {
    count?: number
  }
  mem?: {
    available_kB?: number
  }
  disk?: {
    available_kB?: number
  }
  active?: boolean
}

export interface CrnRecord {
  hash: string
  name?: string
  address?: string
  score?: number | string | null
  qemu_support?: boolean
  city?: string | null
  region?: string | null
  country?: string | null
  country_code?: string | null
  resolved_ip?: string | null
  geo_source?: string | null
  system_usage?: CrnSystemUsage | null
  [key: string]: unknown
}

export type ReferenceStatus = 'processed' | 'pending' | 'rejected' | 'unknown' | 'missing'

export interface RuntimeMetadata {
  hostIpv4?: string | null
  ipv6?: string | null
  proxyUrl?: string | null
  mappedPorts?: Record<string, PortMapping>
}

export interface MessageReference {
  itemHash: string
  status: ReferenceStatus
  type: string | null
}

export interface InstanceAllocationNode {
  node_id?: string
  url?: string
  ipv6?: string | null
  supports_ipv6?: boolean
}

export interface InstanceAllocationPeriod {
  start_timestamp?: string
  duration_seconds?: number
}

export interface InstanceAllocation {
  source: 'scheduler' | 'manual'
  crnHash?: string | null
  crnUrl?: string | null
  node?: InstanceAllocationNode | null
  vmIpv6?: string | null
  period?: InstanceAllocationPeriod | null
}

export interface InstanceExecutionStatus {
  defined_at?: string | null
  preparing_at?: string | null
  prepared_at?: string | null
  starting_at?: string | null
  started_at?: string | null
  stopping_at?: string | null
  stopped_at?: string | null
}

export interface InstanceExecutionNetworking {
  ipv4?: string | null
  ipv6?: string | null
  ipv4_network?: string | null
  host_ipv4?: string | null
  ipv6_network?: string | null
  ipv6_ip?: string | null
  ipv4_ip?: string | null
  proxy_url?: string | null
  mapped_ports?: Record<string, PortMapping>
}

export interface InstanceExecution {
  crnUrl: string
  version: 'v1' | 'v2'
  running?: boolean
  networking: InstanceExecutionNetworking
  status?: InstanceExecutionStatus | null
}

export interface InstanceWebAccess {
  url?: string | null
  active?: boolean | null
  subdomain?: string | null
}

export interface RuntimeDiagnostics {
  state: string
  reason: string | null
  timedOut?: boolean
  schedulerSource?: string | null
  executionSeen?: boolean
  webAccessActive?: boolean | null
  mappedPortCount?: number
  proxyUrl?: string | null
}

export interface InstanceRuntimeDetails {
  messageStatus: 'processed' | 'pending' | 'rejected' | 'unknown'
  allocation: InstanceAllocation | null
  execution: InstanceExecution | null
  webAccess?: InstanceWebAccess | null
  webAccessUrl?: string | null
  hostIpv4?: string | null
  ipv6?: string | null
  proxyUrl?: string | null
  mappedPorts?: Record<string, PortMapping>
  diagnostics?: RuntimeDiagnostics | null
  sshCommand?: string | null
  selectedCrn?: CrnRecord | null
  executionLookupBlocked?: boolean
  error?: string | null
}
