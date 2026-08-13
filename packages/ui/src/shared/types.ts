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
  apiHosts?: string | readonly string[]
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
  code?: 'manifest-invalid' | 'rootfs-not-found' | 'rootfs-verifying' | 'rootfs-pending' | 'rootfs-unavailable' | 'rootfs-ready'
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
  /**
   * Hostname of the deployment's HTTPS proxy. The mapped ports are plain HTTP,
   * which a browser on an HTTPS page refuses to fetch, so this is the only
   * address the card can read the relay's own documents from.
   */
  proxyHostname: string | null
  mappedPorts: Array<{ label: string; hostPort: number | null }>
  execution: InstanceExecution | null
  error: string | null
}

/** One transport's worth of addresses, as the relay itself groups them. */
export interface SponsorRelayAddressGroup {
  key: string
  label: string
  addresses: string[]
}

/**
 * What a deployment reports about itself at `/multiaddrs`. Deliberately not
 * normalised into "the best address": the card shows what the relay says, and
 * choosing between addresses is the consumer's business, not this UI's.
 */
export interface SponsorRelayInstanceAddresses {
  status: 'idle' | 'loading' | 'ready' | 'unsupported' | 'error'
  /** Transport groups, empty for a profile that publishes no libp2p addresses. */
  groups: SponsorRelayAddressGroup[]
  /** Ready-to-paste environment block, when the profile publishes one. */
  pwaEnv: Record<string, string> | null
  /** Raw payload, rendered verbatim on the health tab. */
  payload: Record<string, unknown> | null
  peerId: string | null
  version: string | null
  fetchedAt: number | null
  error: string | null
  /** Source URL, shown so a person can curl exactly what the card read. */
  sourceUrl: string | null
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
  crnOptions: Array<{ hash: string; name: string | null; score: number | null }>
  crnPinnedByUser: boolean
  instances: CompactInstanceRecord[]
  bootstrapRegistrations: CompactBootstrapRegistrationRecord[]
  orphanBootstrapRegistrations: CompactBootstrapRegistrationRecord[]
  lastDeploymentHash: string | null
  deploymentProgress: DeploymentProgressEvent
  /**
   * What each deployment reports at `/multiaddrs`, keyed by instance item hash.
   * Fetched on demand rather than with the instance list: AutoTLS addresses only
   * appear a minute or two after a deploy reports success, so this is state that
   * has to be refreshable on its own.
   */
  instanceAddresses: Record<string, SponsorRelayInstanceAddresses>
}

export type SponsorRelaySubscriber = (state: SponsorRelayState) => void
