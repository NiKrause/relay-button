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

export interface BalanceResponse {
  address: string
  balance: string
  locked_amount: string
  details?: Record<string, string>
  credit_balance: number
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
