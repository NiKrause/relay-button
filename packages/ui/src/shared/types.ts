import type {
  BalanceResponse,
  Crn,
  InstanceExecution,
  InstanceMessage,
  InstancePricing,
  RootfsManifest,
  RootfsManifestState,
  RootfsResolution,
  Tier
} from '../../../browser/src/types.ts'
import type { DeploymentProgressEvent } from '../../../shared-types/src/deployment.ts'

export type SponsorRelayHealthTone = 'ok' | 'caution' | 'error' | 'idle'

export interface SponsorRelayProps {
  libp2p?: unknown
  debug?: boolean
  manifestUrl?: string
  manifestJson?: string
  sshPublicKey?: string
  instanceName?: string
  showInstances?: boolean
  openByDefault?: boolean
  launcherMode?: 'floating' | 'inline'
  version?: string
  apiHost?: string
  crnListUrl?: string
  schedulerApiHost?: string
  twoN6ApiHost?: string
}

export interface SponsorRelayWalletState {
  connected: boolean
  address: string | null
  chainId: string | null
  isMetaMask: boolean
}

export interface SponsorRelayPricingSummary {
  pricing: InstancePricing | null
  tier: Tier | null
  requiredCredits: number | null
  availableCredits: number | null
  vcpus: number | null
  memoryMiB: number | null
  diskMiB: number | null
}

export interface SponsorRelayRootfsHealth {
  tone: SponsorRelayHealthTone
  label: string
  detail: string | null
}

export interface RelayPingState {
  tone: SponsorRelayHealthTone
  sent: boolean
  received: boolean
  lastPeerId: string | null
  lastLatencyMs: number | null
  lastSentAt: number | null
  lastReceivedAt: number | null
  error: string | null
}

export interface CompactInstanceDetails {
  messageStatus: string
  allocationSource: string | null
  crnUrl: string | null
  hostIpv4: string | null
  ipv6: string | null
  vmIpv4: string | null
  webUrl: string | null
  sshCommand: string | null
  mappedPorts: Array<{ label: string; hostPort: number | null }>
  execution: InstanceExecution | null
  error: string | null
}

export interface CompactInstanceRecord {
  instance: InstanceMessage
  details: CompactInstanceDetails
}

export interface SponsorRelayState {
  ready: boolean
  open: boolean
  wallet: SponsorRelayWalletState
  manifestUrl: string
  manifestJson: string
  sshPublicKey: string
  instanceName: string
  tierId: string
  showAdvanced: boolean
  showInstances: boolean
  showPasteManifest: boolean
  busy: {
    connectingWallet: boolean
    refreshing: boolean
    deploying: boolean
    deletingInstanceHash: string | null
  }
  statusText: string
  errorText: string | null
  manifestState: RootfsManifestState
  manifest: RootfsManifest | null
  rootfsResolution: RootfsResolution | null
  rootfsVerified: boolean
  rootfsHealth: SponsorRelayRootfsHealth
  pricingSummary: SponsorRelayPricingSummary
  balance: BalanceResponse | null
  crns: Crn[]
  selectedCrn: Crn | null
  instances: CompactInstanceRecord[]
  relayPing: RelayPingState
  lastDeploymentHash: string | null
  deploymentProgress: DeploymentProgressEvent
}

export type SponsorRelaySubscriber = (state: SponsorRelayState) => void
