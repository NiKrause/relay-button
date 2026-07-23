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
  /**
   * When true, the guest fetches its own bootstrap configuration from the
   * Aleph aggregate (using the deployment token embedded in its SSH key)
   * instead of the browser pushing it to the guest's plain-HTTP setup
   * endpoint. Required to deploy from an HTTPS origin at all: a HTTPS page
   * cannot call `http://<vm-ip>:<port>/configure` (mixed content).
   * Images that predate the guest-side fetch must leave this unset.
   */
  supportsBootstrapConfigAggregate?: boolean
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
