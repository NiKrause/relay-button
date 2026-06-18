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

export interface SponsorRelayUcanStoreBootstrapInput {
  adminDid: string
  serviceDid: string
  spaceDid: string
  rootDelegationProof: string
  allowedCapabilities: string
  defaultUserDelegationExpiration: string
  maxUserDelegationExpiration: string
  pwaOrigin: string
  serviceOrigin: string
}

export interface SponsorRelayProps {
  debug?: boolean
  manifestUrl?: string
  manifestJson?: string
  sshPublicKey?: string
  instanceName?: string
  ucanStoreBootstrap?: Partial<SponsorRelayUcanStoreBootstrapInput>
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

export interface CompactBootstrapRegistrationRecord {
  messageHash: string | null
  hash: string | null
  itemHash: string | null
  address: string | null
  time: number | null
  instanceItemHash: string | null
  confirmed: boolean
  content: {
    peerId: string
    registrationId?: string
    multiaddrs: string[]
    browserMultiaddrs?: string[]
    ownerAddress?: string
    publisherAddress?: string
    updatedAt: number
  } | null
}

export interface SponsorRelayState {
  ready: boolean
  open: boolean
  wallet: SponsorRelayWalletState
  manifestUrl: string
  manifestJson: string
  sshPublicKey: string
  instanceName: string
  ucanStoreBootstrap: SponsorRelayUcanStoreBootstrapInput
  tierId: string
  showAdvanced: boolean
  showInstances: boolean
  showPasteManifest: boolean
  busy: {
    connectingWallet: boolean
    refreshing: boolean
    deploying: boolean
    deletingInstanceHash: string | null
    deletingRegistrationHash: string | null
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
  bootstrapRegistrations: CompactBootstrapRegistrationRecord[]
  orphanBootstrapRegistrations: CompactBootstrapRegistrationRecord[]
  lastDeploymentHash: string | null
  deploymentProgress: DeploymentProgressEvent
}

export type SponsorRelaySubscriber = (state: SponsorRelayState) => void
