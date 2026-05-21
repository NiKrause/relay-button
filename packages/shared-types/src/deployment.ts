import type { MessageReference } from './runtime'

export interface DeploymentResult {
  itemHash: string
  httpStatus?: number
  status: 'processed' | 'pending' | 'rejected' | 'unknown'
  message?: AlephBroadcastMessage
  response?: AlephBroadcastResponse
  rejectionReason?: string | null
}

export type AlephSenderChain = 'ETH'
export type AlephMessageType = 'INSTANCE' | 'FORGET' | 'AGGREGATE' | 'STORE'

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
  message_status?: 'processed' | 'pending' | 'rejected' | 'unknown'
  details?: unknown
  [key: string]: unknown
}

export interface AlephAggregateContent<T = Record<string, unknown>> {
  address: string
  key: string
  content: T
  time: number
}

export interface AlephInstanceContent {
  address: string
  time: number
  allow_amend: boolean
  metadata?: { name: string; [key: string]: string | number | boolean }
  authorized_keys?: string[]
  environment: {
    internet: boolean
    aleph_api: boolean
    reproducible?: boolean
    shared_cache?: boolean
    hypervisor: 'qemu'
    trusted_execution?: Record<string, unknown>
  }
  resources: {
    vcpus: number
    memory: number
    seconds: number
  }
  payment: {
    chain?: string
    receiver?: string
    type: string
  }
  requirements?: {
    node?: {
      node_hash: string
    }
  }
  volumes: unknown[]
  rootfs: {
    parent: {
      ref: string
      use_latest?: boolean
    }
    persistence: 'host' | 'store'
    size_mib: number
  }
}

export interface DeploymentIntent {
  ownerAddress: string
  messageTime: number
  itemHash: string
  paymentType: string
  rootfsRef: string
  rootfsSizeMiB: number
  computeUnits: number
  vcpus: number
  memoryMiB: number
  crnHash: string | null
  channel: string
  expiresAt: number
  maxCost: string
}

export interface DeploymentIntentEnvelope {
  intent: DeploymentIntent
  intentHash: string
}

export interface MessageInspectionResult {
  status: 'processed' | 'pending' | 'rejected' | 'unknown'
  errorCode: number | null
  details: Record<string, unknown> | null
  rejectionReason: string | null
}

export interface DeploymentInspectionResult extends MessageInspectionResult {
  references: MessageReference[]
}

export type MessageSigner = (
  sender: string,
  payload: string
) => Promise<string>

export type MessageHasher = (
  payload: string
) => Promise<string> | string
