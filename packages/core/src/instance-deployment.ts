import type {
  AlephBroadcastMessage,
  AlephInstanceContent,
  DeploymentIntentEnvelope,
  DeploymentResult,
  MessageHasher,
  MessageSigner
} from '@le-space/shared-types'

import { broadcastAlephMessage } from './broadcast.ts'
import { DEFAULT_ALEPH_CHANNEL } from './constants.ts'
export const SSH_PUBLIC_KEY_PATTERN =
  /^(ssh-rsa|ssh-ed25519|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)\s+[A-Za-z0-9+/]+={0,3}(?:\s+.+)?$/

export interface TierSpec {
  vcpus: number
  memoryMiB: number
  diskMiB: number
}

export interface PaymentQuote {
  required: number
  available: number
  computeUnits: number
  unitPrice: number
  label: 'credits'
}

function toFiniteNumber(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.trim()) return Number(value)
  return Number.NaN
}

export function normalizeSshPublicKey(value: string): string {
  return value
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function isValidSshPublicKey(value: string): boolean {
  return SSH_PUBLIC_KEY_PATTERN.test(normalizeSshPublicKey(value))
}

export function createReleaseMetadata(name: string, rootfsVersion: string, deployer = 'shared-aleph-tooling') {
  return {
    name,
    rootfs_version: rootfsVersion,
    deployer
  }
}

export function selectedTier<TTier extends { id: string }>(
  pricing: { tiers: TTier[] } | null,
  tierId: string
): TTier | null {
  return pricing?.tiers.find((tier) => tier.id === tierId) ?? null
}

export function tierSpec<TTier extends { compute_units: number }>(
  pricing: {
    compute_unit: {
      vcpus: number
      memory_mib: number
      disk_mib: number
    }
  },
  tier: TTier
): TierSpec {
  return {
    vcpus: pricing.compute_unit.vcpus * tier.compute_units,
    memoryMiB: pricing.compute_unit.memory_mib * tier.compute_units,
    diskMiB: pricing.compute_unit.disk_mib * tier.compute_units
  }
}

export function buildPaymentQuote<TTier extends { compute_units: number }>(
  tier: TTier,
  pricing: {
    price: {
      compute_unit?: {
        credit?: string | number | null
      } | null
    }
  },
  balance: {
    credit_balance?: number | null
  }
): PaymentQuote | null {
  const computeUnitPrice = pricing.price.compute_unit
  if (!computeUnitPrice) return null

  const unitPrice = toFiniteNumber(computeUnitPrice.credit)
  if (!Number.isFinite(unitPrice)) return null

  return {
    required: unitPrice * tier.compute_units,
    available: Number(balance.credit_balance ?? 0),
    computeUnits: tier.compute_units,
    unitPrice,
    label: 'credits'
  }
}

export function quoteRequiredBudgetUnits(quote: PaymentQuote | null): bigint {
  if (!quote) return 0n
  return BigInt(Math.ceil(quote.required * 1_000_000_000_000_000_000))
}

export function createInstanceContent(args: {
  address: string
  name: string
  sshPublicKey: string
  rootfsItemHash: string
  rootfsSizeMiB: number
  vcpus: number
  memoryMiB: number
  seconds?: number
  rootfsVersion?: string
  crnHash?: string
  deployer?: string
  now?: number
}): AlephInstanceContent {
  const sshKey = normalizeSshPublicKey(args.sshPublicKey)
  if (!sshKey) {
    throw new Error('An SSH public key is required.')
  }
  if (!isValidSshPublicKey(sshKey)) {
    throw new Error('SSH public key must be a single valid .pub line.')
  }
  if (!args.rootfsItemHash || !/^[a-fA-F0-9]{64}$/.test(args.rootfsItemHash)) {
    throw new Error('rootfsItemHash must be a 64-character Aleph item hash.')
  }

  return {
    address: args.address,
    time: args.now ?? Date.now() / 1000,
    allow_amend: false,
    metadata: createReleaseMetadata(args.name.trim(), args.rootfsVersion ?? 'custom-rootfs', args.deployer),
    authorized_keys: [sshKey],
    environment: {
      internet: true,
      aleph_api: true,
      hypervisor: 'qemu',
      reproducible: false,
      shared_cache: false
    },
    resources: {
      vcpus: Number(args.vcpus),
      memory: Number(args.memoryMiB),
      seconds: Number(args.seconds ?? 30)
    },
    payment: {
      type: 'credit'
    },
    requirements: args.crnHash
      ? {
          node: {
            node_hash: args.crnHash
          }
        }
      : undefined,
    volumes: [],
    rootfs: {
      parent: {
        ref: args.rootfsItemHash,
        use_latest: true
      },
      persistence: 'host',
      size_mib: Number(args.rootfsSizeMiB)
    }
  }
}

export async function createUnsignedInstanceMessage(args: {
  sender: string
  content: AlephInstanceContent
  hasher: MessageHasher
  channel?: string
  now?: number
}): Promise<Omit<AlephBroadcastMessage, 'signature'>> {
  const itemContent = JSON.stringify(args.content)
  const itemHash = await args.hasher(itemContent)

  return {
    sender: args.sender,
    chain: 'ETH',
    type: 'INSTANCE',
    item_hash: itemHash,
    item_type: 'inline',
    item_content: itemContent,
    time: args.now ?? Date.now() / 1000,
    channel: args.channel ?? DEFAULT_ALEPH_CHANNEL
  }
}

export async function createDeploymentIntent(args: {
  sender: string
  unsignedMessage: Omit<AlephBroadcastMessage, 'signature'>
  content: AlephInstanceContent
  computeUnits: number
  expiresAt: number
  maxCost: string
  hasher: MessageHasher
}): Promise<DeploymentIntentEnvelope> {
  const intent = {
    ownerAddress: args.sender,
    messageTime: args.unsignedMessage.time,
    itemHash: args.unsignedMessage.item_hash,
    paymentType: args.content.payment.type,
    rootfsRef: args.content.rootfs.parent.ref,
    rootfsSizeMiB: args.content.rootfs.size_mib,
    computeUnits: args.computeUnits,
    vcpus: args.content.resources.vcpus,
    memoryMiB: args.content.resources.memory,
    crnHash: args.content.requirements?.node?.node_hash ?? null,
    channel: args.unsignedMessage.channel,
    expiresAt: args.expiresAt,
    maxCost: args.maxCost
  } as const

  return {
    intent,
    intentHash: await args.hasher(JSON.stringify(intent))
  }
}

export async function deployInstance(args: {
  sender: string
  content: AlephInstanceContent
  hasher: MessageHasher
  signer: MessageSigner
  fetch: (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>
  apiHost?: string
  channel?: string
  sync?: boolean
  now?: number
}): Promise<DeploymentResult> {
  const unsignedMessage = await createUnsignedInstanceMessage({
    sender: args.sender,
    content: args.content,
    hasher: args.hasher,
    channel: args.channel,
    now: args.now
  })

  const signature = await args.signer(unsignedMessage.sender, [unsignedMessage.chain, unsignedMessage.sender, unsignedMessage.type, unsignedMessage.item_hash].join('\n'))
  const message: AlephBroadcastMessage = {
    ...unsignedMessage,
    signature: signature.startsWith('0x') ? signature : `0x${signature}`
  }

  const { response, httpStatus } = await broadcastAlephMessage(message, {
    apiHost: args.apiHost,
    sync: args.sync,
    fetch: args.fetch
  })

  const status =
    httpStatus === 202
      ? 'pending'
      : typeof response.message_status === 'string'
        ? response.message_status
        : 'unknown'

  return {
    itemHash: message.item_hash,
    httpStatus,
    status,
    message,
    response,
    rejectionReason: status === 'rejected' ? String(response.details ?? 'Aleph rejected this deployment.') : null
  }
}
