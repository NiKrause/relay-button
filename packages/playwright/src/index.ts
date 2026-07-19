import { createHash } from 'node:crypto'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { fetchAlephBootstrapPosts, type RelayBootstrapContent, type RelayBootstrapPostRecord } from '@le-space/aleph-bootstrap'
import { eraseInstanceOnCrn, forgetAlephMessages } from '@le-space/core'
import { type Browser, test as playwrightTest, type BrowserContext, type Locator, type Page } from '@playwright/test'

export const PLAYWRIGHT_RUNNER_VERSION = '1.61.1'

export const SUPPORTED_ALEPH_API_HOSTS = ['https://api2.aleph.im', 'https://api.aleph.im'] as const
export const DEFAULT_ALEPH_SCHEDULER_URL = 'https://scheduler.api.aleph.cloud'

const API3_HOST_PATTERN = /(^|\.)api3\.aleph\.im$/iu

export interface RelayWalletAccount {
  address: string
  signMessage(args: { message: string | { raw: `0x${string}` } }): Promise<string>
}

export interface RelayEvidenceStep {
  label: string
  status: 'pending' | 'passed' | 'failed' | 'skipped'
  detail?: string
}

export interface RelayEvidence {
  instanceName: string
  ownerAddress: string
  startedAt: string
  finishedAt?: string
  instanceHash?: string
  steps: Record<string, RelayEvidenceStep>
  error?: string
  [key: string]: unknown
}

export interface AlephChromiumConnector {
  connect(wsEndpoint: string, options?: { headers?: Record<string, string>; timeout?: number }): Promise<Browser>
}

export interface AlephRemoteBrowserOptions {
  chromium: AlephChromiumConnector
  wsEndpoint: string
  versionUrl: string
  secret: string
  expectedVersion?: string
  timeoutMs?: number
  fetch?: typeof fetch
}

export interface AlephCreditBalanceSnapshot {
  capturedAt: string
  apiHost: string
  creditBalance: number
  lockedAmount: number
}

export interface AlephPricingSnapshot {
  capturedAt: string
  apiHost: string
  unitCredit: number
  computeUnits: number
  vcpus: number
  memoryMiB: number
  diskMiB: number
}

export interface AlephCostEvidence {
  paymentType: 'credit'
  startedAt: string
  finishedAt: string
  runtimeSeconds: number
  pricing: AlephPricingSnapshot
  before: AlephCreditBalanceSnapshot
  after: AlephCreditBalanceSnapshot
  requiredCredits: number
  netAccountCreditDelta: number
  creditsConsumed: number
  creditsReturned: number
  accountingNote: string
}

export interface AlephRunnerInstanceCandidate {
  itemHash: string
  ownerAddress: string
  instanceName: string
  createdAt: string
  status: string
}

export interface AlephRunnerJanitorSelection {
  expired: AlephRunnerInstanceCandidate[]
  retained: Array<AlephRunnerInstanceCandidate & { reason: string }>
}

export interface RelayAddressPolicy {
  allowWebTransport?: boolean
  allowWebRtcDirect?: boolean
  allowSecureWebSocket?: boolean
  requireCertificateHash?: boolean
}

export interface WaitForPubsubSubscriberOptions {
  topic: string
  peerId: string
  timeoutMs?: number
  pollIntervalMs?: number
  stableForMs?: number
}

export interface RelayButtonDriverOptions {
  launcherName?: string | RegExp
  instanceNamePlaceholder?: string
  sshPublicKeyPlaceholder?: string
  connectWalletName?: string
  deployButtonName?: string
  deleteButtonName?: string
  refreshButtonName?: string
}

export interface ProvisionRelayOptions {
  accountAddress: string
  instanceName: string
  sshPublicKey: string
  startedAt?: number
  apiHosts?: readonly string[]
  manifestTimeoutMs?: number
  provisionTimeoutMs?: number
  registrationTimeoutMs?: number
  registrationPollIntervalMs?: number
  driver?: RelayButtonDriver
  addressPolicy?: RelayAddressPolicy
  fetch?: typeof fetch
  onDeploymentSubmitted?: () => void
  onPhase?: (phase: 'wallet-and-manifest-ready' | 'deployment-submitted' | 'instance-resolved' | 'bootstrap-resolved', detail?: string) => void
}

export interface ProvisionedRelay {
  instanceName: string
  instanceHash: string
  ownerAddress: string
  startedAt: number
  peerId: string
  addresses: string[]
  registration: RelayBootstrapPostRecord
  driver: RelayButtonDriver
}

export interface CleanupRelayOptions {
  page: Page
  account: RelayWalletAccount
  instanceName: string
  instanceHash: string
  driver?: RelayButtonDriver
  apiHosts?: readonly string[]
  schedulerUrl?: string
  channel?: string
  uiGracePeriodMs?: number
  timeoutMs?: number
  pollIntervalMs?: number
  eraseFirst?: boolean
  fetch?: typeof fetch
  hooks?: CleanupRelayHooks
}

export interface CleanupRelayResult {
  instanceHash: string
  uiDeleteRequested: boolean
  fallbackUsed: boolean
  eraseSummary: string
  forgetSummary: string
  verificationSummary: string
}

export interface CleanupRelayHooks {
  erase?: typeof eraseInstanceOnCrn
  forget?: typeof forgetAlephMessages
  verify?: typeof waitForAlephInstanceDeletion
}

export interface RelayLifecycleFixture {
  provision(page: Page, options: Omit<ProvisionRelayOptions, 'accountAddress'>): Promise<ProvisionedRelay>
  cleanupAll(): Promise<CleanupRelayResult[]>
  evidence: RelayEvidence
}

export interface CreateRelayTestOptions {
  account: RelayWalletAccount
  evidence: RelayEvidence
  cleanup?: Omit<CleanupRelayOptions, 'page' | 'account' | 'instanceName' | 'instanceHash'>
}

function normalizeApiOrigin(value: string): string | null {
  try {
    const url = new URL(value)
    if (API3_HOST_PATTERN.test(url.hostname)) return null
    return url.origin
  } catch {
    return null
  }
}

export function resolveAlephApiHosts(candidates?: readonly string[]): string[] {
  const allowed = new Set((candidates ?? SUPPORTED_ALEPH_API_HOSTS).map(normalizeApiOrigin).filter((value): value is string => value != null))
  const selected = SUPPORTED_ALEPH_API_HOSTS.filter((host) => allowed.has(host))
  return selected.length > 0 ? [...selected] : [...SUPPORTED_ALEPH_API_HOSTS]
}

function requireFiniteNumber(value: unknown, label: string): number {
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error(`${label} must be a finite number`)
  return number
}

export async function connectAlephChromium(options: AlephRemoteBrowserOptions): Promise<Browser> {
  const expectedVersion = options.expectedVersion ?? PLAYWRIGHT_RUNNER_VERSION
  const secret = options.secret.trim()
  if (!secret) throw new Error('Aleph Playwright secret is required')
  if (!options.wsEndpoint.startsWith('wss://')) {
    throw new Error('Aleph Playwright endpoint must use authenticated WSS')
  }
  if (!options.versionUrl.startsWith('https://')) {
    throw new Error('Aleph Playwright version endpoint must use HTTPS')
  }
  const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis)
  if (!fetchImpl) throw new Error('A fetch implementation is required for version verification')
  const authorization = `Bearer ${secret}`
  const response = await fetchImpl(options.versionUrl, {
    headers: { Authorization: authorization },
    cache: 'no-store',
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
  })
  if (!response.ok) {
    throw new Error(`Aleph Playwright version endpoint returned HTTP ${response.status}`)
  }
  const payload = (await response.json()) as { playwrightVersion?: unknown }
  const actualVersion = String(payload.playwrightVersion ?? '')
  if (actualVersion !== expectedVersion) {
    throw new Error(`Playwright client/server version mismatch: client ${expectedVersion}, guest ${actualVersion || 'unknown'}`)
  }
  return options.chromium.connect(options.wsEndpoint, {
    headers: { Authorization: authorization },
    timeout: options.timeoutMs ?? 30_000,
  })
}

export function buildAlephCostEvidence(options: {
  startedAt: string
  finishedAt: string
  pricing: AlephPricingSnapshot
  before: AlephCreditBalanceSnapshot
  after: AlephCreditBalanceSnapshot
}): AlephCostEvidence {
  const startedAtMs = Date.parse(options.startedAt)
  const finishedAtMs = Date.parse(options.finishedAt)
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(finishedAtMs) || finishedAtMs < startedAtMs) {
    throw new Error('Aleph cost evidence requires ordered ISO start/finish timestamps')
  }
  const unitCredit = requireFiniteNumber(options.pricing.unitCredit, 'unitCredit')
  const computeUnits = requireFiniteNumber(options.pricing.computeUnits, 'computeUnits')
  const beforeCredits = requireFiniteNumber(options.before.creditBalance, 'before.creditBalance')
  const afterCredits = requireFiniteNumber(options.after.creditBalance, 'after.creditBalance')
  const netAccountCreditDelta = afterCredits - beforeCredits

  return {
    paymentType: 'credit',
    startedAt: options.startedAt,
    finishedAt: options.finishedAt,
    runtimeSeconds: Math.ceil((finishedAtMs - startedAtMs) / 1_000),
    pricing: options.pricing,
    before: options.before,
    after: options.after,
    requiredCredits: unitCredit * computeUnits,
    netAccountCreditDelta,
    creditsConsumed: Math.max(0, -netAccountCreditDelta),
    creditsReturned: Math.max(0, netAccountCreditDelta),
    accountingNote:
      'Required credits are Aleph credit-payment capacity, not a time-pro-rated charge. The balance delta is the authoritative account observation for this interval and is attributable to this test only when the deployment account is not used concurrently.',
  }
}

export function formatAlephCostGithubSummary(cost: AlephCostEvidence): string {
  return (
    `## Aleph remote browser cost\n\n` +
    `| Field | Value |\n| --- | ---: |\n` +
    `| Payment type | ${cost.paymentType} |\n` +
    `| Runtime | ${cost.runtimeSeconds} s |\n` +
    `| Hardware | ${cost.pricing.vcpus} vCPU · ${cost.pricing.memoryMiB} MiB RAM · ${cost.pricing.diskMiB} MiB disk |\n` +
    `| Compute units | ${cost.pricing.computeUnits} |\n` +
    `| Unit credit requirement | ${cost.pricing.unitCredit} credits |\n` +
    `| Required credit capacity | ${cost.requiredCredits} credits |\n` +
    `| Balance before | ${cost.before.creditBalance} credits |\n` +
    `| Balance after cleanup | ${cost.after.creditBalance} credits |\n` +
    `| Net account delta | ${cost.netAccountCreditDelta} credits |\n` +
    `| Credits consumed | ${cost.creditsConsumed} credits |\n` +
    `| Credits returned | ${cost.creditsReturned} credits |\n\n` +
    `Pricing source: \`${cost.pricing.apiHost}\` at ${cost.pricing.capturedAt}. ` +
    `Balance sources: \`${cost.before.apiHost}\` and \`${cost.after.apiHost}\`.\n\n` +
    `> ${cost.accountingNote}\n`
  )
}

export function selectExpiredAlephPlaywrightRunners(options: {
  candidates: readonly AlephRunnerInstanceCandidate[]
  ownerAddress: string
  repository: string
  now?: number
  ttlMs?: number
}): AlephRunnerJanitorSelection {
  const owner = options.ownerAddress.trim().toLowerCase()
  const repository = options.repository.trim().toLowerCase().replace(/[^a-z0-9]+/gu, '-')
  if (!/^0x[a-f0-9]{40}$/u.test(owner)) throw new Error('Janitor requires an exact EVM owner address')
  if (!repository) throw new Error('Janitor requires a repository name')
  const prefix = `playwright-${repository}-`
  const now = options.now ?? Date.now()
  const ttlMs = options.ttlMs ?? 60 * 60_000
  if (!Number.isFinite(ttlMs) || ttlMs < 15 * 60_000) throw new Error('Janitor TTL must be at least 15 minutes')
  const selection: AlephRunnerJanitorSelection = { expired: [], retained: [] }

  for (const candidate of options.candidates) {
    let reason = ''
    const createdAt = Date.parse(candidate.createdAt)
    if (!/^[a-f0-9]{64}$/iu.test(candidate.itemHash)) reason = 'invalid exact INSTANCE hash'
    else if (candidate.ownerAddress.toLowerCase() !== owner) reason = 'different owner'
    else if (!candidate.instanceName.toLowerCase().startsWith(prefix)) reason = 'name outside repository scope'
    else if (!Number.isFinite(createdAt)) reason = 'invalid creation timestamp'
    else if (now - createdAt < ttlMs) reason = 'within TTL'
    else if (!['processed', 'pending'].includes(candidate.status.toLowerCase())) reason = `terminal status ${candidate.status}`

    if (reason) selection.retained.push({ ...candidate, reason })
    else selection.expired.push(candidate)
  }
  return selection
}

export async function waitForPubsubSubscriber(page: Page, options: WaitForPubsubSubscriberOptions): Promise<string[]> {
  const timeoutMs = options.timeoutMs ?? 30_000
  const pollIntervalMs = options.pollIntervalMs ?? 250
  const stableForMs = options.stableForMs ?? 1_000
  const deadline = Date.now() + timeoutMs
  let stableSince: number | null = null
  let subscribers: string[] = []

  while (Date.now() <= deadline) {
    subscribers = await page.evaluate((topic) => {
      const pubsub = (
        window as unknown as {
          libp2p?: {
            services?: {
              pubsub?: { getSubscribers(topic: string): unknown[] }
            }
          }
        }
      ).libp2p?.services?.pubsub
      if (!pubsub) return []
      try {
        return pubsub.getSubscribers(topic).map(String)
      } catch {
        return []
      }
    }, options.topic)

    if (subscribers.includes(options.peerId)) {
      stableSince ??= Date.now()
      if (Date.now() - stableSince >= stableForMs) return subscribers
    } else {
      stableSince = null
    }

    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) break
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, remainingMs)))
  }

  throw new Error(
    `PubSub subscriber ${options.peerId} was not stable on ${options.topic} within ${timeoutMs}ms; last subscribers: ${subscribers.join(', ') || 'none'}`,
  )
}

export async function installEip1193WalletMock(context: BrowserContext, account: RelayWalletAccount): Promise<void> {
  await context.exposeBinding('__relayE2eWalletRequest', async (_source, request: unknown) => {
    const { method, params = [] } = request as {
      method?: string
      params?: unknown[]
    }
    switch (method) {
      case 'eth_requestAccounts':
      case 'eth_accounts':
        return [account.address]
      case 'eth_chainId':
        return '0x1'
      case 'personal_sign': {
        const payload = params.find((value) => typeof value === 'string' && value.startsWith('0x') && value.toLowerCase() !== account.address.toLowerCase())
        if (typeof payload !== 'string') {
          throw new Error('personal_sign did not contain a payload')
        }
        return account.signMessage({
          message: { raw: payload as `0x${string}` },
        })
      }
      default:
        throw new Error(`Unsupported E2E wallet method: ${method ?? 'missing'}`)
    }
  })

  await context.addInitScript(() => {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
    Object.defineProperty(window, 'ethereum', {
      configurable: true,
      value: {
        isMetaMask: true,
        request: (request: unknown) =>
          (
            window as unknown as {
              __relayE2eWalletRequest: (value: unknown) => Promise<unknown>
            }
          ).__relayE2eWalletRequest(request),
        on(event: string, listener: (...args: unknown[]) => void) {
          const eventListeners = listeners.get(event) ?? new Set()
          eventListeners.add(listener)
          listeners.set(event, eventListeners)
        },
        removeListener(event: string, listener: (...args: unknown[]) => void) {
          listeners.get(event)?.delete(listener)
        },
      },
    })
  })
}

export class RelayButtonDriver {
  readonly page: Page
  readonly options: Required<RelayButtonDriverOptions>

  constructor(page: Page, options: RelayButtonDriverOptions = {}) {
    this.page = page
    this.options = {
      launcherName: options.launcherName ?? 'Relay Button',
      instanceNamePlaceholder: options.instanceNamePlaceholder ?? 'Instance name',
      sshPublicKeyPlaceholder: options.sshPublicKeyPlaceholder ?? 'SSH public key',
      connectWalletName: options.connectWalletName ?? 'Connect MetaMask',
      deployButtonName: options.deployButtonName ?? 'Deploy Relay',
      deleteButtonName: options.deleteButtonName ?? 'Delete',
      refreshButtonName: options.refreshButtonName ?? 'Refresh',
    }
  }

  deployButton(): Locator {
    return this.page.getByRole('button', {
      name: this.options.deployButtonName,
    })
  }

  instance(instanceName: string): Locator {
    return this.page.locator('details').filter({ hasText: instanceName }).first()
  }

  async prepare(options: { instanceName: string; sshPublicKey: string }): Promise<void> {
    const launcher = this.page.getByRole('button', {
      name: this.options.launcherName,
    })
    await launcher.waitFor({ state: 'visible', timeout: 60_000 })
    await launcher.click()
    await this.page.getByPlaceholder(this.options.instanceNamePlaceholder).fill(options.instanceName)
    await this.page.getByText('Advanced', { exact: true }).click()
    await this.page.getByPlaceholder(this.options.sshPublicKeyPlaceholder).fill(options.sshPublicKey)
    await this.page
      .getByRole('button', {
        name: this.options.connectWalletName,
        exact: true,
      })
      .click()
  }

  async requestDelete(instanceName: string): Promise<void> {
    await this.page
      .getByRole('button', { name: this.options.refreshButtonName })
      .click()
      .catch(() => {})
    const instance = this.instance(instanceName)
    await instance.waitFor({ state: 'visible', timeout: 60_000 })
    await instance.getByRole('button', { name: this.options.deleteButtonName, exact: true }).click()
  }
}

export async function waitForDeployableManifest(
  page: Page,
  options: {
    timeoutMs?: number
    terminalStates?: readonly string[]
  } = {},
): Promise<void> {
  const terminalStates = options.terminalStates ?? [
    'manifest rootfs not deployable',
    'manifest invalid',
    'not found on Aleph',
    'Rootfs unavailable — deployment blocked',
    'Rejected by Aleph',
  ]
  const outcome = await page.waitForFunction(
    ({ states }) => {
      const panelText = document.querySelector('aside')?.textContent ?? document.body.textContent ?? ''
      const failure = states.find((state) => panelText.includes(state))
      if (failure) return { status: 'error', message: failure }
      const deployButton = [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Deploy Relay') as
        | HTMLButtonElement
        | undefined
      return deployButton && !deployButton.disabled ? { status: 'ready' } : null
    },
    { states: terminalStates },
    { timeout: options.timeoutMs ?? 120_000, polling: 500 },
  )
  const result = (await outcome.jsonValue()) as {
    status?: string
    message?: string
  } | null
  if (result?.status === 'error') {
    throw new Error(`Relay Button manifest is not deployable: ${result.message}. Republish the rootfs and update the manifest before provisioning.`)
  }
}

async function waitForDeploymentUi(page: Page, instanceName: string, timeoutMs: number): Promise<void> {
  const outcome = await page.waitForFunction(
    (expectedName) => {
      const instance = [...document.querySelectorAll('details')].find(
        (element) =>
          element.textContent?.includes(expectedName) && [...element.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'Delete'),
      )
      if (instance?.textContent?.includes('Aleph bootstrap registered')) {
        return { status: 'instance' }
      }
      const error = document.querySelector('aside.panel .alert.error')?.textContent?.trim()
      if (error) return { status: 'error', message: error }
      const panelText = document.querySelector('aside')?.textContent ?? ''
      const deployButton = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Deploy'))
      if (panelText.includes('Deployment failed') && !deployButton?.textContent?.includes('Deploying')) {
        return { status: 'error', message: panelText }
      }
      return null
    },
    instanceName,
    { timeout: timeoutMs, polling: 500 },
  )
  const result = (await outcome.jsonValue()) as {
    status?: string
    message?: string
  } | null
  if (result?.status === 'error') {
    throw new Error(`Relay Button deployment failed: ${result.message}`)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function findAlephInstanceHash(options: {
  ownerAddress: string
  instanceName: string
  startedAt: number
  apiHosts?: readonly string[]
  timeoutMs?: number
  pollIntervalMs?: number
  fetch?: typeof fetch
}): Promise<string> {
  const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis)
  if (!fetchImpl) throw new Error('A fetch implementation is required for INSTANCE lookup')
  const deadline = Date.now() + (options.timeoutMs ?? 60_000)
  const hosts = resolveAlephApiHosts(options.apiHosts)
  let lastSummary = 'No Aleph replica responded.'

  while (Date.now() < deadline) {
    const observations: string[] = []
    for (const apiHost of hosts) {
      try {
        const url = new URL('/api/v0/messages.json', apiHost)
        url.searchParams.set('msgTypes', 'INSTANCE')
        url.searchParams.set('addresses', options.ownerAddress)
        url.searchParams.set('message_statuses', 'processed,pending,rejected')
        url.searchParams.set('pagination', '100')
        url.searchParams.set('page', '1')
        url.searchParams.set('sortOrder', '-1')
        const response = await fetchImpl(url, { cache: 'no-cache' })
        if (!response.ok) {
          observations.push(`${apiHost}: HTTP ${response.status}`)
          continue
        }
        const payload = (await response.json()) as {
          messages?: Record<string, unknown>[]
        }
        const instance = payload.messages?.find((message) => {
          const content = message.content as { metadata?: { name?: string } } | undefined
          const timestamp = Number(message.reception_time ?? message.time ?? 0) * 1000
          return content?.metadata?.name === options.instanceName && timestamp >= options.startedAt - 60_000
        })
        if (typeof instance?.item_hash === 'string' && instance.item_hash) {
          return instance.item_hash
        }
        observations.push(`${apiHost}: no matching INSTANCE`)
      } catch (error) {
        observations.push(`${apiHost}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    lastSummary = observations.join('; ')
    await delay(options.pollIntervalMs ?? 2_000)
  }
  throw new Error(`Could not resolve Aleph INSTANCE for ${options.instanceName}: ${lastSummary}`)
}

export async function waitForBootstrapRegistration(options: {
  ownerAddress: string
  instanceName: string
  startedAt: number
  apiHosts?: readonly string[]
  timeoutMs?: number
  pollIntervalMs?: number
  fetch?: typeof fetch
  fetchPosts?: typeof fetchAlephBootstrapPosts
}): Promise<RelayBootstrapPostRecord> {
  const deadline = Date.now() + (options.timeoutMs ?? 90_000)
  const hosts = resolveAlephApiHosts(options.apiHosts)
  const fetchPosts = options.fetchPosts ?? fetchAlephBootstrapPosts
  let lastSummary = 'No bootstrap posts returned.'

  while (Date.now() < deadline) {
    for (const apiHost of hosts) {
      try {
        const posts = await fetchPosts({
          apiHost,
          pagination: 200,
          fetch: options.fetch,
        })
        const registration = posts.find(({ address, content }) => {
          if (!content) return false
          const owner = (content.ownerAddress ?? content.publisherAddress ?? address)?.toLowerCase()
          const addresses = content.browserMultiaddrs?.length ? content.browserMultiaddrs : content.multiaddrs
          return (
            owner === options.ownerAddress.toLowerCase() &&
            content.registrationId?.includes(`:${options.instanceName}:`) &&
            content.updatedAt >= options.startedAt - 60_000 &&
            addresses.length > 0
          )
        })
        if (registration) return registration
        lastSummary = `${apiHost}: ${posts.length} posts checked`
      } catch (error) {
        lastSummary = `${apiHost}: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    await delay(options.pollIntervalMs ?? 10_000)
  }
  throw new Error(`Relay bootstrap registration timed out: ${lastSummary}`)
}

export function selectBrowserRelayAddresses(
  content: Pick<RelayBootstrapContent, 'browserMultiaddrs' | 'multiaddrs'>,
  policy: RelayAddressPolicy = {},
): string[] {
  const resolvedPolicy = {
    allowWebTransport: policy.allowWebTransport ?? true,
    allowWebRtcDirect: policy.allowWebRtcDirect ?? true,
    allowSecureWebSocket: policy.allowSecureWebSocket ?? true,
    requireCertificateHash: policy.requireCertificateHash ?? true,
  }
  const candidates = content.browserMultiaddrs?.length ? content.browserMultiaddrs : content.multiaddrs
  const rank = (address: string) => {
    if (address.includes('/webtransport/')) return 0
    if (address.includes('/webrtc-direct/')) return 1
    if (address.includes('.libp2p.direct/')) return 2
    if (address.includes('.2n6.me/')) return 3
    return 4
  }

  return [...new Set(candidates)]
    .filter((address) => {
      if (resolvedPolicy.allowSecureWebSocket && /\/(?:tls\/ws|wss)\/p2p\//u.test(address)) {
        return true
      }
      const hasPeer = /\/p2p\//u.test(address)
      const hasCertificate = /\/certhash\//u.test(address)
      const authenticated = !resolvedPolicy.requireCertificateHash || hasCertificate
      if (resolvedPolicy.allowWebTransport && /\/webtransport\//u.test(address)) {
        return hasPeer && authenticated
      }
      if (resolvedPolicy.allowWebRtcDirect && /\/webrtc-direct\//u.test(address)) {
        return hasPeer && authenticated
      }
      return false
    })
    .sort((left, right) => rank(left) - rank(right))
}

export async function provisionRelay(page: Page, options: ProvisionRelayOptions): Promise<ProvisionedRelay> {
  const startedAt = options.startedAt ?? Date.now()
  const driver = options.driver ?? new RelayButtonDriver(page)
  await driver.prepare({
    instanceName: options.instanceName,
    sshPublicKey: options.sshPublicKey,
  })
  await waitForDeployableManifest(page, {
    timeoutMs: options.manifestTimeoutMs,
  })
  options.onPhase?.('wallet-and-manifest-ready')
  await driver.deployButton().click()
  options.onDeploymentSubmitted?.()
  options.onPhase?.('deployment-submitted')
  await waitForDeploymentUi(page, options.instanceName, options.provisionTimeoutMs ?? 32 * 60_000)
  const instanceHash = await findAlephInstanceHash({
    ownerAddress: options.accountAddress,
    instanceName: options.instanceName,
    startedAt,
    apiHosts: options.apiHosts,
    fetch: options.fetch,
  })
  options.onPhase?.('instance-resolved', instanceHash)
  const registration = await waitForBootstrapRegistration({
    ownerAddress: options.accountAddress,
    instanceName: options.instanceName,
    startedAt,
    apiHosts: options.apiHosts,
    timeoutMs: options.registrationTimeoutMs,
    pollIntervalMs: options.registrationPollIntervalMs,
    fetch: options.fetch,
  })
  const content = registration.content
  if (!content?.peerId) throw new Error('Bootstrap registration did not include a peer ID')
  const addresses = selectBrowserRelayAddresses(content, options.addressPolicy)
  if (addresses.length === 0) {
    throw new Error('Relay did not advertise an authenticated browser-dialable address')
  }
  options.onPhase?.('bootstrap-resolved', `${content.peerId}: ${addresses.join(', ')}`)
  return {
    instanceName: options.instanceName,
    instanceHash,
    ownerAddress: options.accountAddress,
    startedAt,
    peerId: content.peerId,
    addresses,
    registration,
    driver,
  }
}

export async function waitForAlephInstanceDeletion(options: {
  instanceHash: string
  apiHosts?: readonly string[]
  schedulerUrl?: string
  timeoutMs?: number
  pollIntervalMs?: number
  fetch?: typeof fetch
}): Promise<string> {
  const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis)
  if (!fetchImpl) throw new Error('A fetch implementation is required for cleanup verification')
  const deadline = Date.now() + (options.timeoutMs ?? 5 * 60_000)
  const hosts = resolveAlephApiHosts(options.apiHosts)
  const schedulerUrl = new URL(`/api/v0/allocation/${options.instanceHash}`, options.schedulerUrl ?? DEFAULT_ALEPH_SCHEDULER_URL)
  let lastSummary = 'Deletion has not been observed yet.'

  while (Date.now() < deadline) {
    const observations: string[] = []
    let replicasForgotten = true
    for (const apiHost of hosts) {
      try {
        const response = await fetchImpl(new URL(`/api/v0/messages/${options.instanceHash}`, apiHost), { cache: 'no-cache' })
        const payload = (await response.json().catch(() => null)) as {
          status?: string
          forgotten_by?: string[]
        } | null
        const forgotten = payload?.status === 'forgotten' || Boolean(payload?.forgotten_by?.length)
        replicasForgotten &&= forgotten
        observations.push(`${apiHost}: ${forgotten ? 'forgotten' : (payload?.status ?? `HTTP ${response.status}`)}`)
      } catch (error) {
        replicasForgotten = false
        observations.push(`${apiHost}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    let unallocated = false
    try {
      const response = await fetchImpl(schedulerUrl, { cache: 'no-cache' })
      const payload = (await response.json().catch(() => null)) as {
        error?: string
      } | null
      unallocated = response.status === 404 || payload?.error === 'VM is not allocated to any node'
      observations.push(`scheduler: ${unallocated ? 'unallocated' : `HTTP ${response.status}`}`)
    } catch (error) {
      observations.push(`scheduler: ${error instanceof Error ? error.message : String(error)}`)
    }

    lastSummary = observations.join('; ')
    if (replicasForgotten && unallocated) return lastSummary
    await delay(options.pollIntervalMs ?? 2_000)
  }
  throw new Error(`Aleph INSTANCE ${options.instanceHash} was not deleted within ${options.timeoutMs ?? 5 * 60_000}ms: ${lastSummary}`)
}

export async function cleanupRelay(options: CleanupRelayOptions): Promise<CleanupRelayResult> {
  if (!/^[a-f0-9]{64}$/iu.test(options.instanceHash)) {
    throw new Error(`Invalid Aleph INSTANCE hash: ${options.instanceHash}`)
  }
  const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis)
  if (!fetchImpl) throw new Error('A fetch implementation is required for Relay cleanup')
  const driver = options.driver ?? new RelayButtonDriver(options.page)
  const verify = options.hooks?.verify ?? waitForAlephInstanceDeletion
  const erase = options.hooks?.erase ?? eraseInstanceOnCrn
  const forget = options.hooks?.forget ?? forgetAlephMessages
  const hosts = resolveAlephApiHosts(options.apiHosts)
  let uiDeleteRequested = false

  try {
    await driver.requestDelete(options.instanceName)
    uiDeleteRequested = true
  } catch {
    // The owner-signed fallback below is authoritative.
  }

  if (uiDeleteRequested) {
    try {
      const verificationSummary = await verify({
        instanceHash: options.instanceHash,
        apiHosts: hosts,
        schedulerUrl: options.schedulerUrl,
        timeoutMs: options.uiGracePeriodMs ?? 20_000,
        pollIntervalMs: options.pollIntervalMs,
        fetch: fetchImpl,
      })
      return {
        instanceHash: options.instanceHash,
        uiDeleteRequested,
        fallbackUsed: false,
        eraseSummary: 'Relay Button UI requested runtime erase',
        forgetSummary: 'Relay Button UI submitted FORGET',
        verificationSummary,
      }
    } catch {
      // Continue with an awaited owner-signed fallback.
    }
  }

  const signer = (_sender: string, payload: string) => options.account.signMessage({ message: payload })
  let eraseSummary = 'CRN erase skipped by configuration'
  if (options.eraseFirst ?? true) {
    let lastError = 'No Aleph API host attempted.'
    for (const apiHost of hosts) {
      try {
        const result = await erase({
          sender: options.account.address,
          signer,
          instanceHash: options.instanceHash,
          fetch: fetchImpl,
          apiHost,
        })
        eraseSummary = `CRN ${result.status}${result.crnUrl ? ` at ${result.crnUrl}` : ''}`
        lastError = ''
        break
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
    }
    if (lastError) eraseSummary = `CRN erase unavailable: ${lastError}`
  }

  const hasher = (content: string) => createHash('sha256').update(content).digest('hex')
  let forgetSummary = ''
  let lastForgetError = 'No Aleph API host attempted.'
  for (const apiHost of hosts) {
    try {
      const result = await forget({
        sender: options.account.address,
        hashes: [options.instanceHash],
        reason: 'Relay Button Playwright cleanup',
        signer,
        hasher,
        fetch: fetchImpl,
        channel: options.channel,
        apiHost,
        sync: true,
      })
      if (result.status === 'rejected') {
        throw new Error(`Aleph rejected FORGET: ${JSON.stringify(result.response)}`)
      }
      forgetSummary = `FORGET ${result.itemHash} ${result.status} via ${apiHost}`
      lastForgetError = ''
      break
    } catch (error) {
      lastForgetError = error instanceof Error ? error.message : String(error)
    }
  }
  if (lastForgetError) throw new Error(`Relay cleanup FORGET failed: ${lastForgetError}`)

  const verificationSummary = await verify({
    instanceHash: options.instanceHash,
    apiHosts: hosts,
    schedulerUrl: options.schedulerUrl,
    timeoutMs: options.timeoutMs,
    pollIntervalMs: options.pollIntervalMs,
    fetch: fetchImpl,
  })
  return {
    instanceHash: options.instanceHash,
    uiDeleteRequested,
    fallbackUsed: true,
    eraseSummary,
    forgetSummary,
    verificationSummary,
  }
}

export function createRelayEvidence(options: { instanceName: string; ownerAddress: string; steps: Record<string, string>; startedAt?: number }): RelayEvidence {
  return {
    instanceName: options.instanceName,
    ownerAddress: options.ownerAddress,
    startedAt: new Date(options.startedAt ?? Date.now()).toISOString(),
    steps: Object.fromEntries(Object.entries(options.steps).map(([key, label]) => [key, { label, status: 'pending' as const }])),
  }
}

export function updateRelayEvidenceStep(evidence: RelayEvidence, step: string, status: RelayEvidenceStep['status'], detail = ''): void {
  const current = evidence.steps[step]
  if (!current) throw new Error(`Unknown Relay evidence step: ${step}`)
  evidence.steps[step] = { ...current, status, detail }
}

export async function writeRelayEvidence(path: string, evidence: RelayEvidence): Promise<void> {
  evidence.finishedAt ??= new Date().toISOString()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`)
}

export function formatRelayGithubSummary(evidence: RelayEvidence, title = 'Relay Button E2E'): string {
  const icons: Record<RelayEvidenceStep['status'], string> = {
    passed: '✅',
    failed: '❌',
    pending: '⏳',
    skipped: '➖',
  }
  const rows = Object.values(evidence.steps).map((step) => {
    const detail = String(step.detail ?? '')
      .replaceAll('|', '\\|')
      .replaceAll('\n', ' ')
    return `| ${icons[step.status]} | ${step.label} | ${detail || '—'} |`
  })
  const failed = Object.values(evidence.steps).some((step) => step.status === 'failed') || evidence.error
  const metadata = [
    `- Instance: \`${evidence.instanceName}\``,
    evidence.instanceHash ? `- Aleph INSTANCE: \`${evidence.instanceHash}\`` : '',
    evidence.error ? `- Error: ${evidence.error.replaceAll('\n', ' ')}` : '',
  ].filter(Boolean)
  return (
    [
      `## ${title}`,
      '',
      `**Result:** ${failed ? '❌ Failed' : '✅ Passed'}`,
      '',
      '| Status | Test step | Details |',
      '| --- | --- | --- |',
      ...rows,
      '',
      ...metadata,
      '',
    ].join('\n') + '\n'
  )
}

export async function appendRelayGithubSummary(evidence: RelayEvidence, options: { path?: string; title?: string } = {}): Promise<string> {
  const summary = formatRelayGithubSummary(evidence, options.title)
  const path = options.path ?? process.env.GITHUB_STEP_SUMMARY
  if (path) await appendFile(path, summary)
  return summary
}

export function createRelayTest(options: CreateRelayTestOptions) {
  return playwrightTest.extend<{ relayLifecycle: RelayLifecycleFixture }>({
    relayLifecycle: async ({}, use) => {
      const tracked: { page: Page; relay: ProvisionedRelay }[] = []
      const lifecycle: RelayLifecycleFixture = {
        evidence: options.evidence,
        async provision(page, provisionOptions) {
          const startedAt = provisionOptions.startedAt ?? Date.now()
          try {
            const relay = await provisionRelay(page, {
              ...provisionOptions,
              accountAddress: options.account.address,
              startedAt,
            })
            tracked.push({ page, relay })
            options.evidence.instanceHash = relay.instanceHash
            return relay
          } catch (error) {
            const instanceHash = await findAlephInstanceHash({
              ownerAddress: options.account.address,
              instanceName: provisionOptions.instanceName,
              startedAt,
              apiHosts: provisionOptions.apiHosts,
              fetch: provisionOptions.fetch,
              timeoutMs: 15_000,
            }).catch(() => null)
            if (instanceHash) {
              tracked.push({
                page,
                relay: {
                  instanceName: provisionOptions.instanceName,
                  instanceHash,
                  ownerAddress: options.account.address,
                  startedAt,
                  peerId: '',
                  addresses: [],
                  registration: {} as RelayBootstrapPostRecord,
                  driver: provisionOptions.driver ?? new RelayButtonDriver(page),
                },
              })
              options.evidence.instanceHash = instanceHash
            }
            throw error
          }
        },
        async cleanupAll() {
          const results: CleanupRelayResult[] = []
          const errors: Error[] = []
          for (const { page, relay } of tracked.reverse()) {
            try {
              results.push(
                await cleanupRelay({
                  ...options.cleanup,
                  page,
                  account: options.account,
                  instanceName: relay.instanceName,
                  instanceHash: relay.instanceHash,
                  driver: relay.driver,
                }),
              )
            } catch (error) {
              errors.push(error instanceof Error ? error : new Error(String(error)))
            }
          }
          tracked.length = 0
          if (errors.length > 0) {
            throw new AggregateError(errors, 'One or more Relay Button cleanups failed')
          }
          return results
        },
      }
      await use(lifecycle)
      await lifecycle.cleanupAll()
    },
  })
}
