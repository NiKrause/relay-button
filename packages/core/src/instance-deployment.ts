import type {
  AlephBroadcastMessage,
  AlephInstanceContent,
  DeploymentResult,
  MessageHasher,
  MessageSigner
} from '@shared-aleph/shared-types'

import { broadcastAlephMessage } from './broadcast.ts'

export const DEFAULT_ALEPH_CHANNEL = 'TEST'
export const SSH_PUBLIC_KEY_PATTERN =
  /^(ssh-rsa|ssh-ed25519|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)\s+[A-Za-z0-9+/]+={0,3}(?:\s+.+)?$/

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
