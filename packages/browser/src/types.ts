export type BrowserExtractionPhase = 'planned' | 'scaffolded'

export interface BrowserPackagePlan {
  phase: BrowserExtractionPhase
  modules: string[]
}

export const BROWSER_PACKAGE_PLAN: BrowserPackagePlan = {
  phase: 'scaffolded',
  modules: ['http', 'aleph-api', 'rootfs', 'pricing']
}

export type MessageStatus = 'processed' | 'pending' | 'rejected' | 'unknown'
export type ReferenceStatus = MessageStatus | 'missing'
export type AlephSenderChain = 'ETH'
export type AlephMessageType = 'INSTANCE' | 'FORGET' | 'AGGREGATE'

export interface BalanceResponse {
  address: string
  balance: string
  locked_amount: string
  details?: Record<string, string>
  credit_balance: number
}

export interface Price {
  payg?: string | number | null
  holding?: string | number | null
  fixed?: string | number | null
  credit?: string | number | null
}

export interface ComputeUnit {
  vcpus: number
  memory_mib: number
  disk_mib: number
}

export interface Tier {
  id: string
  compute_units: number
  vram?: number | null
  model?: string | null
}

export interface InstancePricing {
  price: {
    storage?: Price
    compute_unit?: Price
  }
  compute_unit: ComputeUnit
  tiers: Tier[]
}

export interface PricingState {
  pricing: InstancePricing | null
  fetchedAt: number | null
}

export interface CrnUsage {
  cpu?: { count?: number }
  mem?: { available_kB?: number }
  disk?: { available_kB?: number }
  active?: boolean
}

export interface CrnLocation {
  city?: string | null
  region?: string | null
  country?: string | null
  country_code?: string | null
}

export interface Crn {
  hash: string
  name: string
  address: string
  score?: number | string | null
  performance?: number | string | null
  decentralization?: number | string | null
  qemu_support?: boolean
  confidential_support?: boolean
  gpu_support?: boolean
  system_usage?: CrnUsage | null
  payment_receiver_address?: string | null
  version?: string | null
  city?: string | null
  region?: string | null
  country?: string | null
  country_code?: string | null
  location?: CrnLocation | string | null
  resolved_ip?: string | null
  geo_source?: string | null
}

export interface CrnListResponse {
  crns: Crn[]
}

export type PaymentMode = 'hold' | 'credit'

export interface InstanceMessage {
  item_hash: string
  sender: string
  chain: string
  type: 'INSTANCE'
  channel?: string
  content?: {
    metadata?: { name?: string }
    payment?: { type?: PaymentMode; chain?: string }
    rootfs?: { parent?: { ref?: string }; size_mib?: number }
    requirements?: { node?: { node_hash?: string } }
  }
  time?: string | number
  reception_time?: string
  confirmed?: boolean
  status?: string
}

export interface AlephMessageEnvelope {
  status?: unknown
  type?: unknown
  error_code?: unknown
  details?: unknown
  message?: { type?: unknown } | null
  messages?: Array<{ type?: unknown }> | null
  [key: string]: unknown
}

export interface MessageReference {
  itemHash: string
  status: ReferenceStatus
  type: string | null
}

export interface DeploymentInspectionResult {
  status: MessageStatus
  errorCode: number | null
  details: Record<string, unknown> | null
  rejectionReason: string | null
  references: MessageReference[]
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

export interface AllocationNotifyResult {
  status: 'confirmed' | 'unconfirmed'
}

export interface AlephBroadcastMessage {
  sender: string
  chain: AlephSenderChain
  signature: string
  type: AlephMessageType
  item_hash: string
  item_type: 'inline'
  item_content: string
  time: number
  channel: string
}

export interface AlephBroadcastResponse {
  publication_status?: {
    status: string
    failed?: unknown[]
  }
  message_status?: MessageStatus
  [key: string]: unknown
}

export interface BroadcastResult {
  response: AlephBroadcastResponse
  httpStatus: number
}

export interface AlephBrowserClient {
  apiHost: string
  crnListUrl: string
  schedulerApiHost: string
  fetchBalance(address: string): Promise<BalanceResponse>
  fetchCrns(): Promise<Crn[]>
  fetchInstances(address: string): Promise<InstanceMessage[]>
  fetchMessageEnvelope(itemHash: string): Promise<AlephMessageEnvelope | null>
  fetchSchedulerAllocation(itemHash: string): Promise<InstanceAllocation | null>
  notifyCrnAllocation(crnUrl: string, itemHash: string): Promise<AllocationNotifyResult>
  inspectDeploymentResult(itemHash: string, rootfsRef?: string): Promise<DeploymentInspectionResult>
  waitForDeploymentResult(
    itemHash: string,
    rootfsRef?: string,
    attempts?: number,
    delayMs?: number
  ): Promise<DeploymentInspectionResult>
  broadcastInstanceMessage(message: AlephBroadcastMessage, sync?: boolean): Promise<BroadcastResult>
  broadcastAlephMessage(message: AlephBroadcastMessage, sync?: boolean): Promise<BroadcastResult>
}

export interface RootfsRequiredPortForward {
  port: number
  tcp?: boolean
  udp?: boolean
  purpose?: string
}

export interface RootfsManifest {
  profile?: string
  version: string
  rootfsInstallStrategy?: 'thin' | 'prebaked' | string
  requiresBootstrapNetwork?: boolean
  bootstrapSummary?: string
  requiredPortForwards?: RootfsRequiredPortForward[]
  rootfsItemHash: string
  rootfsSizeMiB: number
  rootfsSourceSizeBytes?: number
  createdAt: string
  notes?: string
}

export interface RootfsManifestState {
  manifest: RootfsManifest | null
  valid: boolean
  errors: string[]
}

export type GatewayProbeStatus = 'reachable' | 'timeout' | 'error' | 'unavailable' | 'unknown'

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
