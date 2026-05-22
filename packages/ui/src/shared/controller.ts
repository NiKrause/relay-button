import {
  createAlephBrowserClient,
  fetchInstancePricing,
  loadRootfsManifest,
  normalizeExecution,
  resolveRootfsReference,
  verifyRootfsExists,
  type Crn,
  type InstanceExecution,
  type InstanceMessage,
  type RootfsManifest,
  type RootfsManifestState
} from '../../../browser/src/index.ts'
import {
  buildPaymentQuote,
  createInstanceContent,
  deployInstance as deploySharedInstance,
  filterDeployableCrns,
  forgetAlephMessages,
  tierSpec
} from '../../../core/src/index.ts'

import {
  DEFAULT_INSTANCE_NAME,
  DEFAULT_MANIFEST_URL,
  DEFAULT_TIER_ID,
  REFRESH_INTERVAL_MS,
  RELAY_PING_IDLE_STATE,
  RELAY_PING_INTERVAL_MS,
  ROOTFS_MISSING_STATE
} from './constants'
import { buildSshCommand } from './format'
import { resolveManifestSource } from './manifest-source'
import { connectWallet, personalSign, watchWallet } from './wallet-controller'
import type {
  CompactInstanceDetails,
  CompactInstanceRecord,
  RelayPingState,
  SponsorRelayProps,
  SponsorRelayRootfsHealth,
  SponsorRelayState,
  SponsorRelaySubscriber
} from './types'

function defaultState(props: SponsorRelayProps = {}): SponsorRelayState {
  return {
    ready: false,
    open: Boolean(props.openByDefault),
    wallet: {
      connected: false,
      address: null,
      chainId: null,
      isMetaMask: false
    },
    manifestUrl: props.manifestUrl ?? DEFAULT_MANIFEST_URL,
    manifestJson: props.manifestJson ?? '',
    sshPublicKey: props.sshPublicKey ?? '',
    instanceName: props.instanceName ?? DEFAULT_INSTANCE_NAME,
    tierId: DEFAULT_TIER_ID,
    showInstances: props.showInstances ?? true,
    showPasteManifest: false,
    busy: {
      connectingWallet: false,
      refreshing: false,
      deploying: false,
      deletingInstanceHash: null
    },
    statusText: 'Ready',
    errorText: null,
    manifestState: {
      manifest: null,
      valid: false,
      errors: ['Manifest not loaded yet.']
    },
    manifest: null,
    rootfsResolution: null,
    rootfsVerified: false,
    rootfsHealth: ROOTFS_MISSING_STATE,
    pricingSummary: {
      pricing: null,
      tier: null,
      requiredCredits: null,
      availableCredits: null,
      vcpus: null,
      memoryMiB: null,
      diskMiB: null
    },
    balance: null,
    crns: [],
    selectedCrn: null,
    instances: [],
    relayPing: RELAY_PING_IDLE_STATE,
    lastDeploymentHash: null
  }
}

async function sha256Hex(payload: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload))
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function mappedPorts(execution: InstanceExecution | null): CompactInstanceDetails['mappedPorts'] {
  return Object.entries(execution?.networking?.mapped_ports ?? {}).map(([port, mapping]) => ({
    label: `${port}/${mapping.udp ? 'udp' : 'tcp'}`,
    hostPort: mapping.host ?? null
  }))
}

function rootfsHealth(args: {
  manifestState: RootfsManifestState
  rootfsVerified: boolean
  resolution: SponsorRelayState['rootfsResolution']
}): SponsorRelayRootfsHealth {
  if (!args.manifestState.valid || !args.manifestState.manifest) {
    return {
      tone: 'error',
      label: 'manifest invalid',
      detail: args.manifestState.errors[0] ?? 'Manifest could not be parsed.'
    }
  }

  if (!args.rootfsVerified) {
    return {
      tone: 'error',
      label: 'not found on Aleph',
      detail: 'The referenced rootfs STORE message is not available yet.'
    }
  }

  if (!args.resolution) {
    return {
      tone: 'caution',
      label: 'verifying rootfs',
      detail: 'The rootfs reference is still being resolved.'
    }
  }

  if (args.resolution.messageStatus === 'processed') {
    return {
      tone: 'ok',
      label: 'deployable',
      detail: args.resolution.gatewayUrl
    }
  }

  if (args.resolution.messageStatus === 'pending' && args.resolution.gatewayStatus === 'reachable') {
    return {
      tone: 'caution',
      label: 'pending but reachable',
      detail: 'Gateway probe succeeded even though Aleph still reports pending.'
    }
  }

  if (args.resolution.messageStatus === 'pending') {
    return {
      tone: 'caution',
      label: 'pending on Aleph',
      detail: 'Wait until the STORE message is processed.'
    }
  }

  return {
    tone: 'error',
    label: 'not deployable',
    detail: args.resolution.rejectionReason ?? 'Aleph rejected the rootfs reference.'
  }
}

async function resolveManifest(args: {
  manifestUrl: string
  manifestJson: string
}): Promise<RootfsManifestState> {
  const pasted = resolveManifestSource({ manifestJson: args.manifestJson })
  if (pasted) return pasted
  return loadRootfsManifest(args.manifestUrl)
}

async function inspectInstanceRuntime(args: {
  client: ReturnType<typeof createAlephBrowserClient>
  instance: InstanceMessage
  crns: Crn[]
}): Promise<CompactInstanceDetails> {
  const details: CompactInstanceDetails = {
    messageStatus: String(args.instance.status ?? (args.instance.confirmed ? 'processed' : 'unknown')).toLowerCase(),
    allocationSource: null,
    crnUrl: null,
    hostIpv4: null,
    ipv6: null,
    vmIpv4: null,
    webUrl: null,
    sshCommand: null,
    mappedPorts: [],
    execution: null,
    error: null
  }

  if (details.messageStatus !== 'processed') {
    return details
  }

  try {
    const allocation =
      (await args.client.fetchSchedulerAllocation(args.instance.item_hash)) ??
      (() => {
        const nodeHash = args.instance.content?.requirements?.node?.node_hash
        const crn = args.crns.find((candidate) => candidate.hash === nodeHash)
        return nodeHash
          ? {
              source: 'manual' as const,
              crnHash: nodeHash,
              crnUrl: crn?.address ?? null,
              node: crn ? { url: crn.address } : null,
              vmIpv6: null,
              period: null
            }
          : null
      })()

    details.allocationSource = allocation?.source ?? null
    details.crnUrl = allocation?.crnUrl ?? null
    details.ipv6 = allocation?.vmIpv6 ?? null
    details.webUrl = await args.client.fetch2n6WebAccessUrl(args.instance.item_hash)

    if (!allocation?.crnUrl) {
      return details
    }

    const executionLookup = await args.client.fetchCrnExecutionMap(allocation.crnUrl)
    const executionPayload = executionLookup.payload?.[args.instance.item_hash]
    if (!executionPayload) {
      return details
    }

    const execution = normalizeExecution(executionPayload, allocation.crnUrl)
    if (!execution.networking.proxy_url && details.webUrl) {
      execution.networking.proxy_url = details.webUrl
    }

    details.execution = execution
    details.hostIpv4 = execution.networking.host_ipv4 ?? execution.networking.ipv4 ?? null
    details.ipv6 = execution.networking.ipv6_ip ?? execution.networking.ipv6 ?? details.ipv6
    details.vmIpv4 = execution.networking.ipv4_ip ?? null
    details.webUrl = execution.networking.proxy_url ?? details.webUrl
    details.mappedPorts = mappedPorts(execution)
    details.sshCommand = buildSshCommand(details.hostIpv4, details.mappedPorts)
    return details
  } catch (error) {
    return {
      ...details,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

function compatibleCrnsForTier(crns: Crn[], state: SponsorRelayState): Crn[] {
  if (!state.pricingSummary.pricing || !state.pricingSummary.tier) {
    return []
  }

  const spec = tierSpec(state.pricingSummary.pricing, state.pricingSummary.tier)
  return filterDeployableCrns(crns, { spec })
}

async function pingPeer(libp2p: unknown): Promise<RelayPingState> {
  if (!libp2p || typeof libp2p !== 'object') {
    return RELAY_PING_IDLE_STATE
  }

  const candidate = libp2p as {
    getPeers?: () => unknown[]
    ping?: (peer: unknown) => Promise<number>
    services?: { ping?: { ping: (peer: unknown) => Promise<number> } }
  }

  const peers = candidate.getPeers?.() ?? []
  const firstPeer = peers[0]
  if (!firstPeer) {
    return {
      ...RELAY_PING_IDLE_STATE,
      tone: 'caution',
      error: 'No connected relay peers available.'
    }
  }

  const sentAt = Date.now()
  try {
    const pingFn = candidate.services?.ping?.ping?.bind(candidate.services.ping) ?? candidate.ping?.bind(candidate)
    if (!pingFn) {
      return {
        ...RELAY_PING_IDLE_STATE,
        tone: 'caution',
        sent: true,
        lastPeerId: String(firstPeer),
        lastSentAt: sentAt,
        error: 'libp2p ping service not available.'
      }
    }

    const latency = await pingFn(firstPeer)
    return {
      tone: 'ok',
      sent: true,
      received: true,
      lastPeerId: String(firstPeer),
      lastLatencyMs: Number(latency),
      lastSentAt: sentAt,
      lastReceivedAt: Date.now(),
      error: null
    }
  } catch (error) {
    return {
      tone: 'error',
      sent: true,
      received: false,
      lastPeerId: String(firstPeer),
      lastLatencyMs: null,
      lastSentAt: sentAt,
      lastReceivedAt: null,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

type SponsorRelayStatePatch = Omit<
  Partial<SponsorRelayState>,
  'busy' | 'wallet' | 'pricingSummary' | 'relayPing'
> & {
  busy?: Partial<SponsorRelayState['busy']>
  wallet?: Partial<SponsorRelayState['wallet']>
  pricingSummary?: Partial<SponsorRelayState['pricingSummary']>
  relayPing?: Partial<SponsorRelayState['relayPing']>
}

export class SponsorRelayController {
  private state: SponsorRelayState
  private subscribers = new Set<SponsorRelaySubscriber>()
  private client: ReturnType<typeof createAlephBrowserClient>
  private refreshTimer: ReturnType<typeof setInterval> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private stopWalletWatch: (() => void) | null = null
  private props: SponsorRelayProps

  constructor(props: SponsorRelayProps = {}) {
    this.props = props
    this.state = defaultState(props)
    this.client = createAlephBrowserClient({
      apiHost: props.apiHost,
      crnListUrl: props.crnListUrl,
      schedulerApiHost: props.schedulerApiHost,
      twoN6ApiHost: props.twoN6ApiHost
    })
  }

  subscribe(subscriber: SponsorRelaySubscriber): () => void {
    this.subscribers.add(subscriber)
    return () => {
      this.subscribers.delete(subscriber)
    }
  }

  getState(): SponsorRelayState {
    return this.state
  }

  private emit() {
    const next = this.state
    this.subscribers.forEach((subscriber) => subscriber(next))
  }

  private patch(patch: SponsorRelayStatePatch) {
    this.state = {
      ...this.state,
      ...patch,
      busy: patch.busy ? { ...this.state.busy, ...patch.busy } : this.state.busy,
      wallet: patch.wallet ? { ...this.state.wallet, ...patch.wallet } : this.state.wallet,
      pricingSummary: patch.pricingSummary
        ? { ...this.state.pricingSummary, ...patch.pricingSummary }
        : this.state.pricingSummary,
      relayPing: patch.relayPing ? { ...this.state.relayPing, ...patch.relayPing } : this.state.relayPing
    }
    this.emit()
  }

  async init(): Promise<void> {
    this.stopWalletWatch = watchWallet(() => {
      void this.refreshWalletDerivedState()
    })
    await this.refresh()
    this.refreshTimer = setInterval(() => {
      void this.refresh()
    }, REFRESH_INTERVAL_MS)
    this.pingTimer = setInterval(() => {
      void this.refreshRelayPing()
    }, RELAY_PING_INTERVAL_MS)
    await this.refreshRelayPing()
    this.patch({ ready: true })
  }

  destroy(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer)
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.stopWalletWatch?.()
  }

  setOpen(open: boolean): void {
    this.patch({ open })
  }

  toggleOpen(): void {
    this.patch({ open: !this.state.open })
  }

  setManifestUrl(manifestUrl: string): void {
    this.patch({ manifestUrl })
  }

  setManifestJson(manifestJson: string): void {
    this.patch({ manifestJson })
  }

  setShowPasteManifest(showPasteManifest: boolean): void {
    this.patch({ showPasteManifest })
  }

  setSshPublicKey(sshPublicKey: string): void {
    this.patch({ sshPublicKey })
  }

  setInstanceName(instanceName: string): void {
    this.patch({ instanceName })
  }

  setTierId(tierId: string): void {
    this.patch({ tierId })
    this.recomputePricingSummary()
  }

  private recomputePricingSummary() {
    const pricing = this.state.pricingSummary.pricing
    const tier = pricing?.tiers.find((entry) => entry.id === this.state.tierId) ?? pricing?.tiers[0] ?? null
    const balance = this.state.balance
    const quote = pricing && tier && balance ? buildPaymentQuote(tier, pricing, balance) : null
    const spec = pricing && tier ? tierSpec(pricing, tier) : null
    const selectedCrn = compatibleCrnsForTier(this.state.crns, {
      ...this.state,
      pricingSummary: {
        ...this.state.pricingSummary,
        pricing,
        tier
      }
    } as SponsorRelayState)[0] ?? null

    this.patch({
      pricingSummary: {
        pricing,
        tier,
        requiredCredits: quote?.required ?? null,
        availableCredits: quote?.available ?? balance?.credit_balance ?? null,
        vcpus: spec?.vcpus ?? null,
        memoryMiB: spec?.memoryMiB ?? null,
        diskMiB: spec?.diskMiB ?? null
      },
      selectedCrn
    })
  }

  async connectWallet(): Promise<void> {
    this.patch({
      busy: { connectingWallet: true },
      errorText: null,
      statusText: 'Connecting MetaMask'
    })

    try {
      const wallet = await connectWallet()
      this.patch({
        wallet,
        busy: { connectingWallet: false },
        statusText: 'Wallet connected'
      })
      await this.refresh()
    } catch (error) {
      this.patch({
        busy: { connectingWallet: false },
        errorText: error instanceof Error ? error.message : String(error),
        statusText: 'Wallet connection failed'
      })
    }
  }

  private async refreshWalletDerivedState(): Promise<void> {
    if (!this.state.wallet.connected) {
      return
    }

    try {
      const wallet = await connectWallet()
      this.patch({ wallet })
      await this.refresh()
    } catch {
      this.patch({
        wallet: {
          connected: false,
          address: null,
          chainId: null,
          isMetaMask: false
        }
      })
    }
  }

  async refresh(): Promise<void> {
    this.patch({
      busy: { refreshing: true },
      errorText: null,
      statusText: 'Refreshing relay sponsor data'
    })

    try {
      const manifestState = await resolveManifest({
        manifestUrl: this.state.manifestUrl,
        manifestJson: this.state.manifestJson
      })
      const manifest = manifestState.manifest
      const [pricingSummary, crns] = await Promise.all([
        fetchInstancePricing(this.client.apiHost),
        this.client.fetchCrns()
      ])

      let balance = this.state.balance
      let instances: CompactInstanceRecord[] = []
      if (this.state.wallet.address) {
        const [nextBalance, rawInstances] = await Promise.all([
          this.client.fetchBalance(this.state.wallet.address),
          this.state.showInstances ? this.client.fetchInstances(this.state.wallet.address) : Promise.resolve([])
        ])
        balance = nextBalance
        instances = await Promise.all(
          rawInstances.map(async (instance) => ({
            instance,
            details: await inspectInstanceRuntime({
              client: this.client,
              instance,
              crns
            })
          }))
        )
      }

      let rootfsVerified = false
      let rootfsResolution = null
      if (manifestState.valid && manifest) {
        rootfsVerified = await verifyRootfsExists(manifest.rootfsItemHash, this.client.apiHost)
        rootfsResolution = await resolveRootfsReference(manifest.rootfsItemHash, this.client.apiHost)
      }

      this.patch({
        manifestState,
        manifest,
        rootfsVerified,
        rootfsResolution,
        rootfsHealth: rootfsHealth({
          manifestState,
          rootfsVerified,
          resolution: rootfsResolution
        }),
        pricingSummary: {
          ...this.state.pricingSummary,
          pricing: pricingSummary.pricing
        },
        balance,
        crns,
        instances,
        busy: { refreshing: false },
        statusText: 'Relay sponsor data ready'
      })
      this.recomputePricingSummary()
    } catch (error) {
      this.patch({
        busy: { refreshing: false },
        errorText: error instanceof Error ? error.message : String(error),
        statusText: 'Refresh failed'
      })
    }
  }

  async refreshRelayPing(): Promise<void> {
    const relayPing = await pingPeer(this.props.libp2p)
    this.patch({ relayPing })
  }

  async deploy(): Promise<void> {
    if (!this.state.wallet.address) {
      this.patch({ errorText: 'Connect MetaMask before deploying.' })
      return
    }
    if (!this.state.manifest || !this.state.rootfsVerified || !this.state.pricingSummary.pricing || !this.state.pricingSummary.tier) {
      this.patch({ errorText: 'Manifest, rootfs, and pricing must be ready before deploying.' })
      return
    }

    this.patch({
      busy: { deploying: true },
      errorText: null,
      statusText: 'Broadcasting deployment'
    })

    try {
      const spec = tierSpec(this.state.pricingSummary.pricing, this.state.pricingSummary.tier)
      const content = createInstanceContent({
        address: this.state.wallet.address,
        name: this.state.instanceName.trim(),
        sshPublicKey: this.state.sshPublicKey.trim(),
        rootfsItemHash: this.state.manifest.rootfsItemHash,
        rootfsSizeMiB: Math.max(this.state.manifest.rootfsSizeMiB, spec.diskMiB),
        vcpus: spec.vcpus,
        memoryMiB: spec.memoryMiB,
        rootfsVersion: this.state.manifest.version,
        crnHash: this.state.selectedCrn?.hash
      })

      const result = await deploySharedInstance({
        sender: this.state.wallet.address,
        content,
        hasher: sha256Hex,
        signer: personalSign,
        fetch: (url, init) => fetch(url, init),
        apiHost: this.client.apiHost,
        sync: false
      })

      this.patch({
        busy: { deploying: false },
        statusText: `Deployment submitted: ${result.itemHash}`,
        lastDeploymentHash: result.itemHash
      })
      await this.refresh()
    } catch (error) {
      this.patch({
        busy: { deploying: false },
        errorText: error instanceof Error ? error.message : String(error),
        statusText: 'Deployment failed'
      })
    }
  }

  async deleteInstance(instanceHash: string): Promise<void> {
    if (!this.state.wallet.address) {
      this.patch({ errorText: 'Connect MetaMask before deleting instances.' })
      return
    }

    this.patch({
      busy: { deletingInstanceHash: instanceHash },
      errorText: null,
      statusText: `Deleting ${instanceHash}`
    })

    try {
      await forgetAlephMessages({
        sender: this.state.wallet.address,
        hashes: [instanceHash],
        reason: 'Deleted from Sponsor Relay panel',
        signer: personalSign,
        hasher: sha256Hex,
        fetch: (url, init) =>
          fetch(url, init).then(async (response) => ({
            ok: response.ok,
            status: response.status,
            json: async () => await response.json()
          })),
        apiHost: this.client.apiHost
      })

      this.patch({
        busy: { deletingInstanceHash: null },
        statusText: `Deletion submitted for ${instanceHash}`
      })
      await this.refresh()
    } catch (error) {
      this.patch({
        busy: { deletingInstanceHash: null },
        errorText: error instanceof Error ? error.message : String(error),
        statusText: 'Delete failed'
      })
    }
  }
}

export function createSponsorRelayController(props: SponsorRelayProps = {}): SponsorRelayController {
  return new SponsorRelayController(props)
}
