import type { RelayPingState, SponsorRelayRootfsHealth } from './types'

export const DEFAULT_INSTANCE_NAME = 'sponsor-relay'
export const DEFAULT_MANIFEST_URL = './rootfs-manifest.json'
export const DEFAULT_TIER_ID = 'tier-1'
export const ROOTFS_MISSING_STATE: SponsorRelayRootfsHealth = {
  tone: 'idle',
  label: 'manifest missing',
  detail: 'Provide a manifest URL or paste manifest JSON.'
}
export const RELAY_PING_IDLE_STATE: RelayPingState = {
  tone: 'idle',
  sent: false,
  received: false,
  lastPeerId: null,
  lastLatencyMs: null,
  lastSentAt: null,
  lastReceivedAt: null,
  error: null
}
export const REFRESH_INTERVAL_MS = 30_000
export const RELAY_PING_INTERVAL_MS = 20_000
