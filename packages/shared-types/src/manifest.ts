export interface RootfsRequiredPortForward {
  port: number
  tcp?: boolean
  udp?: boolean
  purpose?: string
}

export type MessageStatus = 'processed' | 'pending' | 'rejected' | 'removing' | 'removed' | 'unknown'
export type GatewayProbeStatus = 'reachable' | 'timeout' | 'error' | 'unavailable' | 'unknown'
export type RootfsInstallStrategy = 'thin' | 'prebaked'

export interface RootfsManifest {
  profile?: string
  version: string
  rootfsInstallStrategy?: RootfsInstallStrategy
  requiresBootstrapNetwork?: boolean
  bootstrapSummary?: string
  rootfsItemHash?: string
  rootfsCid?: string
  rootfsSizeMiB: number
  rootfsSourceSizeBytes?: number
  requiredPortForwards?: RootfsRequiredPortForward[]
  createdAt: string
  notes?: string
}

export interface RootfsManifestState {
  manifest: RootfsManifest | null
  valid: boolean
  errors: string[]
}

export interface PortForwardFlags {
  tcp: boolean
  udp: boolean
}

export interface PortForwardAggregateEntry {
  ports?: Record<string, PortForwardFlags>
}

export type PortForwardAggregate = Record<string, PortForwardAggregateEntry>

export interface RootfsResolution {
  itemHash: string
  messageStatus: MessageStatus
  messageType: string | null
  cid: string | null
  receptionTime?: string | null
  rejectionErrorCode?: number | null
  rejectionReason?: string | null
  gatewayUrl: string | null
  gatewayStatus: GatewayProbeStatus
  gatewayError?: string | null
}
