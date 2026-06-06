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
  type RootfsManifestState,
} from "../../../browser/src/index.ts";
import {
  appendDeploymentTokenToSshPublicKey,
  buildPaymentQuote,
  createRelayBootstrapRegistrationId,
  configureOrbitdbRelaySetup,
  createDeploymentToken,
  createInstanceContent,
  deleteVmBootstrapConfig,
  deployInstance as deploySharedInstance,
  ensureInstancePortForwards,
  fetchRelayMetadataForRuntime,
  filterDeployableCrns,
  forgetAlephMessages,
  notifyCrnAllocationWithRetry,
  publishVmBootstrapConfig,
  publishRelayBootstrapRegistration,
  reconcileOwnerRelayBootstrapRegistrations,
  tierSpec,
  waitForDeploymentResult,
  waitForSetupEndpoint,
  waitForVmRuntime,
} from "../../../core/src/index.ts";

import {
  DEFAULT_INSTANCE_NAME,
  DEFAULT_MANIFEST_URL,
  DEFAULT_TIER_ID,
  DEPLOYMENT_PENDING_WARNING_MS,
  IDLE_DEPLOYMENT_PROGRESS,
  MANIFEST_SOURCE_REFRESH_DEBOUNCE_MS,
  RECENT_INSTANCE_RUNTIME_GRACE_MS,
  REFRESH_INTERVAL_MS,
  RELAY_PING_IDLE_STATE,
  RELAY_PING_INTERVAL_MS,
  ROOTFS_MISSING_STATE,
  STALE_INSTANCE_ALLOCATION_COOLDOWN_MS,
} from "./constants";
import { createDeploymentProgressEmitter } from "./events";
import { buildSshCommand } from "./format";
import { resolveManifestSource } from "./manifest-source";
import { connectWallet, personalSign, watchWallet } from "./wallet-controller";
import type {
  CompactInstanceDetails,
  CompactInstanceRecord,
  RelayPingState,
  SponsorRelayProps,
  SponsorRelayRootfsHealth,
  SponsorRelayState,
  SponsorRelaySubscriber,
} from "./types";
import type {
  DeploymentProgressEvent,
  DeploymentProgressListener,
} from "../../../shared-types/src/deployment.ts";
import type { RootfsManifest as SharedRootfsManifest } from "../../../shared-types/src/manifest.ts";
import type { VmBootstrapConfigRecord } from "../../../shared-types/src/bootstrap-config.ts";

type RelayProfile = "uc-go-peer" | "orbitdb-relay-pinner";

function asJsonFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> {
  return fetch(input, init).then(async (response) => ({
    ok: response.ok,
    status: response.status,
    json: async () => await response.json(),
  }))
}

function isConfirmedRelaySetupResult(value: unknown): value is { status: "configured" } {
  return Boolean(
    value &&
      typeof value === "object" &&
      "status" in value &&
      (value as { status?: unknown }).status === "configured",
  );
}

function defaultState(props: SponsorRelayProps = {}): SponsorRelayState {
  return {
    ready: false,
    open: Boolean(props.openByDefault),
    wallet: {
      connected: false,
      address: null,
      chainId: null,
      isMetaMask: false,
    },
    manifestUrl: props.manifestUrl ?? DEFAULT_MANIFEST_URL,
    manifestJson: props.manifestJson ?? "",
    sshPublicKey: props.sshPublicKey ?? "",
    instanceName: props.instanceName ?? DEFAULT_INSTANCE_NAME,
    tierId: DEFAULT_TIER_ID,
    showAdvanced: Boolean(props.manifestJson?.trim() || props.sshPublicKey?.trim()),
    showInstances: props.showInstances ?? true,
    showPasteManifest: Boolean(props.manifestJson?.trim()),
    busy: {
      connectingWallet: false,
      refreshing: false,
      deploying: false,
      deletingInstanceHash: null,
    },
    statusText: "Ready",
    errorText: null,
    manifestState: {
      manifest: null,
      valid: false,
      errors: ["Manifest not loaded yet."],
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
      diskMiB: null,
    },
    balance: null,
    crns: [],
    selectedCrn: null,
    instances: [],
    relayPing: RELAY_PING_IDLE_STATE,
    lastDeploymentHash: null,
    deploymentProgress: IDLE_DEPLOYMENT_PROGRESS,
  };
}

function manifestLoadErrorState(error: unknown): RootfsManifestState {
  const message = error instanceof Error ? error.message : String(error);
  return {
    manifest: null,
    valid: false,
    errors: [message],
  };
}

function isDebugEnabled(props: SponsorRelayProps): boolean {
  if (props.debug) {
    return true;
  }

  try {
    return globalThis.localStorage?.getItem("LE_SPACE_UI_DEBUG") === "1";
  } catch {
    return false;
  }
}

async function sha256Hex(payload: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(payload),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function mappedPorts(
  execution: InstanceExecution | null,
): CompactInstanceDetails["mappedPorts"] {
  return Object.entries(execution?.networking?.mapped_ports ?? {}).map(
    ([port, mapping]) => ({
      label: `${port}/${mapping.udp ? "udp" : "tcp"}`,
      hostPort: mapping.host ?? null,
    }),
  );
}

function runtimeMappedPorts(
  mappedPortsRecord: Record<
    string,
    { host?: number | null; tcp?: boolean | null; udp?: boolean | null }
  > | null | undefined,
): CompactInstanceDetails["mappedPorts"] {
  return Object.entries(mappedPortsRecord ?? {}).map(([port, mapping]) => ({
    label: `${port}/${mapping.udp ? "udp" : "tcp"}`,
    hostPort: mapping.host ?? null,
  }));
}

function rootfsHealth(args: {
  manifestState: RootfsManifestState;
  rootfsVerified: boolean;
  resolution: SponsorRelayState["rootfsResolution"];
}): SponsorRelayRootfsHealth {
  if (!args.manifestState.valid || !args.manifestState.manifest) {
    return {
      tone: "error",
      label: "manifest invalid",
      detail: args.manifestState.errors[0] ?? "Manifest could not be parsed.",
    };
  }

  if (!args.rootfsVerified) {
    return {
      tone: "error",
      label: "not found on Aleph",
      detail: "The referenced rootfs STORE message is not available yet.",
    };
  }

  if (!args.resolution) {
    return {
      tone: "caution",
      label: "verifying rootfs",
      detail: "The rootfs reference is still being resolved.",
    };
  }

  if (args.resolution.messageStatus === "processed") {
    return {
      tone: "ok",
      label: "deployable",
      detail: args.resolution.gatewayUrl,
    };
  }

  if (
    args.resolution.messageStatus === "pending" &&
    args.resolution.gatewayStatus === "reachable"
  ) {
    return {
      tone: "caution",
      label: "pending but reachable",
      detail:
        "Gateway probe succeeded even though Aleph still reports pending.",
    };
  }

  if (args.resolution.messageStatus === "pending") {
    return {
      tone: "caution",
      label: "pending on Aleph",
      detail: "Wait until the STORE message is processed.",
    };
  }

  return {
    tone: "error",
    label: "not deployable",
    detail:
      args.resolution.rejectionReason ?? "Aleph rejected the rootfs reference.",
  };
}

async function resolveManifest(args: {
  manifestUrl: string;
  manifestJson: string;
}): Promise<RootfsManifestState> {
  const pasted = resolveManifestSource({ manifestJson: args.manifestJson });
  if (pasted) return pasted;
  return loadRootfsManifest(args.manifestUrl);
}

function relayProfileForManifest(
  manifest: RootfsManifest | null | undefined,
): RelayProfile | null {
  if (manifest?.profile === "uc-go-peer") return "uc-go-peer";
  if (manifest?.profile === "orbitdb-relay-pinner") {
    return "orbitdb-relay-pinner";
  }
  return null;
}

async function inspectInstanceRuntime(args: {
  client: ReturnType<typeof createAlephBrowserClient>;
  instance: InstanceMessage;
  crns: Crn[];
}): Promise<{
  details: CompactInstanceDetails;
  lookup: {
    allocationFound: boolean;
    allocationSource: string | null;
    crnUrl: string | null;
    webUrl: string | null;
    executionPayloadFound: boolean;
    executionLookupBlocked: boolean;
    executionLookupRequestUrl: string | null;
    executionLookupVersion: string | null;
  };
}> {
  const details: CompactInstanceDetails = {
    messageStatus: String(
      args.instance.status ??
        (args.instance.confirmed ? "processed" : "unknown"),
    ).toLowerCase(),
    allocationSource: null,
    crnUrl: null,
    hostIpv4: null,
    ipv6: null,
    vmIpv4: null,
    webUrl: null,
    sshCommand: null,
    mappedPorts: [],
    execution: null,
    error: null,
  };
  const lookup = {
    allocationFound: false,
    allocationSource: null as string | null,
    crnUrl: null as string | null,
    webUrl: null as string | null,
    executionPayloadFound: false,
    executionLookupBlocked: false,
    executionLookupRequestUrl: null as string | null,
    executionLookupVersion: null as string | null,
  };

  if (
    details.messageStatus === "rejected" ||
    details.messageStatus === "removing"
  ) {
    return { details, lookup };
  }

  try {
    const allocation =
      (await args.client.fetchSchedulerAllocation(args.instance.item_hash)) ??
      (() => {
        const nodeHash = args.instance.content?.requirements?.node?.node_hash;
        const crn = args.crns.find((candidate) => candidate.hash === nodeHash);
        return nodeHash
          ? {
              source: "manual" as const,
              crnHash: nodeHash,
              crnUrl: crn?.address ?? null,
              node: crn ? { url: crn.address } : null,
              vmIpv6: null,
              period: null,
            }
          : null;
      })();

    lookup.allocationFound = Boolean(allocation);
    lookup.allocationSource = allocation?.source ?? null;
    details.allocationSource = allocation?.source ?? null;
    details.crnUrl = allocation?.crnUrl ?? null;
    details.ipv6 = allocation?.vmIpv6 ?? null;
    details.webUrl = await args.client.fetch2n6WebAccessUrl(
      args.instance.item_hash,
    );
    lookup.crnUrl = details.crnUrl;
    lookup.webUrl = details.webUrl;

    if (!allocation?.crnUrl) {
      return { details, lookup };
    }

    const executionLookup = await args.client.fetchCrnExecutionMap(
      allocation.crnUrl,
    );
    lookup.executionLookupBlocked = executionLookup.blocked;
    lookup.executionLookupRequestUrl = executionLookup.requestUrl ?? null;
    lookup.executionLookupVersion = executionLookup.version ?? null;
    const executionPayload = executionLookup.payload?.[args.instance.item_hash];
    lookup.executionPayloadFound = Boolean(executionPayload);
    if (!executionPayload) {
      return { details, lookup };
    }

    const execution = normalizeExecution(executionPayload, allocation.crnUrl);
    if (!execution.networking.proxy_url && details.webUrl) {
      execution.networking.proxy_url = details.webUrl;
    }

    details.messageStatus = "processed";
    details.execution = execution;
    details.hostIpv4 =
      execution.networking.host_ipv4 ?? execution.networking.ipv4 ?? null;
    details.ipv6 =
      execution.networking.ipv6_ip ?? execution.networking.ipv6 ?? details.ipv6;
    details.vmIpv4 = execution.networking.ipv4_ip ?? null;
    details.webUrl = execution.networking.proxy_url ?? details.webUrl;
    details.mappedPorts = mappedPorts(execution);
    details.sshCommand = buildSshCommand(details.hostIpv4, details.mappedPorts);
    return { details, lookup };
  } catch (error) {
    return {
      details: {
        ...details,
        error: error instanceof Error ? error.message : String(error),
      },
      lookup,
    };
  }
}

function instanceTimestampMs(instance: InstanceMessage): number | null {
  const value = instance.reception_time ?? instance.time;
  if (!value) return null;

  if (typeof value === "number") {
    return value > 0 && value < 10_000_000_000 ? value * 1000 : value;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function compatibleCrnsForTier(crns: Crn[], state: SponsorRelayState): Crn[] {
  if (!state.pricingSummary.pricing || !state.pricingSummary.tier) {
    return [];
  }

  const spec = tierSpec(
    state.pricingSummary.pricing,
    state.pricingSummary.tier,
  );
  return filterDeployableCrns(crns, { spec });
}

async function pingPeer(libp2p: unknown): Promise<RelayPingState> {
  if (!libp2p || typeof libp2p !== "object") {
    return RELAY_PING_IDLE_STATE;
  }

  const candidate = libp2p as {
    getPeers?: () => unknown[];
    ping?: (peer: unknown) => Promise<number>;
    services?: { ping?: { ping: (peer: unknown) => Promise<number> } };
  };

  const peers = candidate.getPeers?.() ?? [];
  const firstPeer = peers[0];
  if (!firstPeer) {
    return {
      ...RELAY_PING_IDLE_STATE,
      tone: "caution",
      error: "No connected relay peers available.",
    };
  }

  const sentAt = Date.now();
  try {
    const pingFn =
      candidate.services?.ping?.ping?.bind(candidate.services.ping) ??
      candidate.ping?.bind(candidate);
    if (!pingFn) {
      return {
        ...RELAY_PING_IDLE_STATE,
        tone: "caution",
        sent: true,
        lastPeerId: String(firstPeer),
        lastSentAt: sentAt,
        error: "libp2p ping service not available.",
      };
    }

    const latency = await pingFn(firstPeer);
    return {
      tone: "ok",
      sent: true,
      received: true,
      lastPeerId: String(firstPeer),
      lastLatencyMs: Number(latency),
      lastSentAt: sentAt,
      lastReceivedAt: Date.now(),
      error: null,
    };
  } catch (error) {
    return {
      tone: "error",
      sent: true,
      received: false,
      lastPeerId: String(firstPeer),
      lastLatencyMs: null,
      lastSentAt: sentAt,
      lastReceivedAt: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const UI_DEPLOY_WAIT_ATTEMPTS = 60;
const UI_DEPLOY_WAIT_DELAY_MS = 5_000;
const UI_RUNTIME_WAIT_ATTEMPTS = 40;
const UI_RUNTIME_WAIT_DELAY_MS = 5_000;

type SponsorRelayStatePatch = Omit<
  Partial<SponsorRelayState>,
  "busy" | "wallet" | "pricingSummary" | "relayPing"
> & {
  busy?: Partial<SponsorRelayState["busy"]>;
  wallet?: Partial<SponsorRelayState["wallet"]>;
  pricingSummary?: Partial<SponsorRelayState["pricingSummary"]>;
  relayPing?: Partial<SponsorRelayState["relayPing"]>;
};

function hasUsableRuntime(details: CompactInstanceDetails): boolean {
  return (
    Boolean(details.hostIpv4) ||
    Boolean(details.vmIpv4) ||
    details.mappedPorts.length > 0 ||
    Boolean(details.webUrl) ||
    Boolean(details.execution)
  );
}

function toSharedRootfsManifest(
  manifest: SponsorRelayState["manifest"],
): SharedRootfsManifest | null {
  if (!manifest) {
    return null;
  }

  return {
    profile: manifest.profile,
    version: manifest.version,
    rootfsInstallStrategy:
      manifest.rootfsInstallStrategy === "thin" ||
      manifest.rootfsInstallStrategy === "prebaked"
        ? manifest.rootfsInstallStrategy
        : undefined,
    requiresBootstrapNetwork: manifest.requiresBootstrapNetwork,
    bootstrapSummary: manifest.bootstrapSummary,
    rootfsItemHash: manifest.rootfsItemHash,
    rootfsSizeMiB: manifest.rootfsSizeMiB,
    rootfsSourceSizeBytes: manifest.rootfsSourceSizeBytes,
    requiredPortForwards: manifest.requiredPortForwards,
    createdAt: manifest.createdAt,
    notes: manifest.notes,
  };
}

export class SponsorRelayController {
  private state: SponsorRelayState;
  private subscribers = new Set<SponsorRelaySubscriber>();
  private client: ReturnType<typeof createAlephBrowserClient>;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private manifestRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private stopWalletWatch: (() => void) | null = null;
  private props: SponsorRelayProps;
  private progressEmitter = createDeploymentProgressEmitter();
  private runtimeCooldownByHash = new Map<string, number>();
  private runtimeDetailsByHash = new Map<string, CompactInstanceDetails>();
  private debugEnabled: boolean;
  private lastRuntimeReadyHash: string | null = null;

  constructor(props: SponsorRelayProps = {}) {
    this.props = props;
    this.state = defaultState(props);
    this.debugEnabled = isDebugEnabled(props);
    this.client = createAlephBrowserClient({
      apiHost: props.apiHost,
      crnListUrl: props.crnListUrl,
      schedulerApiHost: props.schedulerApiHost,
      twoN6ApiHost: props.twoN6ApiHost,
    });
  }

  subscribeToDeploymentProgress(
    listener: DeploymentProgressListener,
  ): () => void {
    return this.progressEmitter.subscribe(listener);
  }

  subscribe(subscriber: SponsorRelaySubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  getState(): SponsorRelayState {
    return this.state;
  }

  updateProps(props: Partial<SponsorRelayProps>): void {
    this.props = { ...this.props, ...props };
    this.debugEnabled = isDebugEnabled(this.props);
  }

  private emit() {
    const next = this.state;
    this.subscribers.forEach((subscriber) => subscriber(next));
  }

  private trace(message: string, data?: unknown) {
    if (!this.debugEnabled) {
      return;
    }

    if (data === undefined) {
      console.debug("[le-space/ui]", message);
      return;
    }

    console.debug("[le-space/ui]", message, data);
  }

  private patch(patch: SponsorRelayStatePatch) {
    this.state = {
      ...this.state,
      ...patch,
      busy: patch.busy
        ? { ...this.state.busy, ...patch.busy }
        : this.state.busy,
      wallet: patch.wallet
        ? { ...this.state.wallet, ...patch.wallet }
        : this.state.wallet,
      pricingSummary: patch.pricingSummary
        ? { ...this.state.pricingSummary, ...patch.pricingSummary }
        : this.state.pricingSummary,
      relayPing: patch.relayPing
        ? { ...this.state.relayPing, ...patch.relayPing }
        : this.state.relayPing,
    };
    this.emit();
  }

  private emitProgress(event: Omit<DeploymentProgressEvent, "timestamp">) {
    const nextEvent: DeploymentProgressEvent = {
      ...event,
      timestamp: Date.now(),
    };
    this.trace(`progress:${nextEvent.stage}`, {
      label: nextEvent.label,
      progress: nextEvent.progress,
      status: nextEvent.status,
      itemHash: nextEvent.itemHash ?? null,
      detail: nextEvent.detail ?? null,
      error: nextEvent.error ?? null,
    });
    this.patch({
      deploymentProgress: nextEvent,
      statusText: event.error ?? event.detail ?? event.label,
      errorText:
        event.status === "error"
          ? (event.error ?? event.detail ?? event.label)
          : this.state.errorText,
    });
    this.progressEmitter.emit(nextEvent);
  }

  private async configureRelayBootstrapRegistration(args: {
    itemHash: string;
    runtime: Awaited<ReturnType<typeof waitForVmRuntime>>;
    deploymentToken?: string | null;
  }): Promise<void> {
    const profile = relayProfileForManifest(this.state.manifest);
    if (!profile) return;

    if (!this.state.wallet.address) {
      throw new Error("A connected wallet is required to register relay bootstrap addresses.");
    }
    if (!args.runtime.hostIpv4) {
      throw new Error("Relay runtime did not expose a host IPv4 address.");
    }

    const mappedPorts = args.runtime.mappedPorts ?? {};
    const setupPort = mappedPorts["80"]?.host ?? null;
    if (!setupPort) {
      throw new Error("Relay runtime did not expose the temporary setup endpoint.");
    }

    if (profile === "orbitdb-relay-pinner") {
      this.emitProgress({
        stage: "deployment-confirmed",
        label: "Configuring relay",
        progress: 93,
        status: "info",
        itemHash: args.itemHash,
        detail: "Waiting for the guest setup endpoint before collecting relay metadata.",
      });

      const setupHealth = await waitForSetupEndpoint({
        hostIpv4: args.runtime.hostIpv4,
        setupPort,
        fetch: (url, init) => fetch(url, init),
        attempts: 15,
        delayMs: 4000,
        httpTimeoutMs: 10000,
      });
      if (!setupHealth.ok) {
        throw new Error(
          `Relay setup endpoint did not become reachable at http://${args.runtime.hostIpv4}:${setupPort}/health.`,
        );
      }

      this.emitProgress({
        stage: "deployment-confirmed",
        label: "Applying relay networking",
        progress: 94,
        status: "info",
        itemHash: args.itemHash,
        detail: "Publishing the host port mapping into the guest relay configuration.",
      });

      const tcpPort = mappedPorts["9091"]?.host ?? 0;
      const wsPort = mappedPorts["9092"]?.host ?? mappedPorts["443"]?.host ?? 0;
      if (!tcpPort || !wsPort) {
        throw new Error("OrbitDB relay runtime is missing required mapped TCP/WS ports.");
      }

      const configureResult = await configureOrbitdbRelaySetup({
        hostIpv4: args.runtime.hostIpv4,
        publicIpv6: args.runtime.ipv6,
        setupPort,
        tcpPort,
        wsPort,
        proxyUrl: args.runtime.proxyUrl ?? undefined,
        metricsPort: mappedPorts["9090"]?.host ?? null,
        metricsHttpsPort: mappedPorts["443"]?.host ?? null,
        webrtcPort: mappedPorts["9093"]?.host ?? null,
        quicPort: mappedPorts["9094"]?.host ?? null,
        fetch: (url, init) => fetch(url, init),
        timeoutMs: 180000,
      });
      if (!isConfirmedRelaySetupResult(configureResult)) {
        throw new Error(
          `Relay guest configuration could not be confirmed at http://${args.runtime.hostIpv4}:${setupPort}/configure.`,
        );
      }
    } else {
      if (!args.deploymentToken) {
        throw new Error("Missing deployment token for Aleph bootstrap config handoff.");
      }

      this.emitProgress({
        stage: "deployment-confirmed",
        label: "Publishing relay config",
        progress: 94,
        status: "info",
        itemHash: args.itemHash,
        detail: "Publishing runtime networking into the Aleph guest bootstrap config aggregate.",
      });

      const record: VmBootstrapConfigRecord = {
        deploymentToken: args.deploymentToken,
        profile,
        ownerAddress: this.state.wallet.address,
        instanceItemHash: args.itemHash,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        status: "pending",
        runtime: {
          publicIpv4: args.runtime.hostIpv4,
          publicIpv6: args.runtime.ipv6 ?? null,
          proxyUrl: args.runtime.proxyUrl ?? null,
          mappedPorts: mappedPorts,
        },
        bootstrap: {
          registrationId: createRelayBootstrapRegistrationId(
            profile,
            this.state.instanceName.trim(),
            args.itemHash,
          ),
        },
      };

      const bootstrapConfigPublication = await publishVmBootstrapConfig({
        sender: this.state.wallet.address,
        record,
        signer: personalSign,
        hasher: sha256Hex,
        fetch: asJsonFetch,
        apiHost: this.client.apiHost,
        sync: true,
      });
      this.trace("deploy:bootstrap-config-published", {
        itemHash: args.itemHash,
        deploymentToken: args.deploymentToken,
        registrationId: record.bootstrap?.registrationId ?? null,
        proxyUrl: record.runtime.proxyUrl ?? null,
        mappedPorts: record.runtime.mappedPorts,
        aggregateItemHash: bootstrapConfigPublication.aggregateItemHash,
        aggregateStatus: bootstrapConfigPublication.aggregateStatus,
      });
    }

    this.emitProgress({
      stage: "publishing-bootstrap",
      label: "Reading relay multiaddrs",
      progress: 95,
      status: "info",
      itemHash: args.itemHash,
      detail: "Waiting for the relay to report its final public multiaddrs.",
    });

    const relayMetadata = await fetchRelayMetadataForRuntime({
      runtime: args.runtime,
      fetch: fetch,
      preferSecureMetadata: profile === "uc-go-peer",
      attempts: 80,
      delayMs: 3000,
      timeoutMs: 240000,
      onAttempt: (result) => {
        const payload =
          result.payload && typeof result.payload === "object"
            ? (result.payload as Record<string, unknown>)
            : null;
        const metadata =
          payload?.metadata && typeof payload.metadata === "object"
            ? (payload.metadata as Record<string, unknown>)
            : null;
        this.trace("deploy:relay-metadata-attempt", {
          itemHash: args.itemHash,
          attempt: result.attempt,
          attempts: result.attempts,
          requestUrl: result.requestUrl,
          metadataUrl: result.metadataUrl,
          hostIpv4: result.hostIpv4,
          setupPort: result.setupPort,
          ok: result.ok,
          status: result.status,
          ready: result.ready,
          error: result.error ?? null,
          payloadStatus:
            payload && typeof payload.status === "string" ? payload.status : null,
          peerId:
            metadata && typeof metadata.peer_id === "string"
              ? metadata.peer_id
              : null,
          probeMultiaddrCount: Array.isArray(metadata?.probe_multiaddrs)
            ? metadata.probe_multiaddrs.length
            : 0,
          browserBootstrapMultiaddrCount: Array.isArray(
            metadata?.browser_bootstrap_multiaddrs,
          )
            ? metadata.browser_bootstrap_multiaddrs.length
            : 0,
        });
      },
    });
    if (!relayMetadata) {
      throw new Error("Relay metadata did not include a peer ID and public multiaddrs.");
    }

    const { peerId, probeMultiaddrs, browserBootstrapMultiaddrs } = relayMetadata;
    const registrationId = createRelayBootstrapRegistrationId(
      profile,
      this.state.instanceName.trim(),
      args.itemHash,
    );

    this.emitProgress({
      stage: "publishing-bootstrap",
      label: "Publishing bootstrap registration",
      progress: 96,
      status: "info",
      itemHash: args.itemHash,
      detail: "Writing the relay bootstrap registration to Aleph.",
    });

    const publication = await publishRelayBootstrapRegistration({
      sender: this.state.wallet.address,
      signer: personalSign,
      hasher: sha256Hex,
      fetch: asJsonFetch,
      apiHost: this.client.apiHost,
      peerId,
      multiaddrs: probeMultiaddrs,
      browserMultiaddrs: browserBootstrapMultiaddrs,
      registrationId,
      profile,
      version: this.state.manifest?.version,
      forgetPrevious: true,
      sync: true,
    });

    this.trace("deploy:bootstrap-registration", {
      itemHash: args.itemHash,
      peerId,
      metadata: relayMetadata,
      publication,
    });

    const reconcileResult = await reconcileOwnerRelayBootstrapRegistrations({
      instanceOwnerAddress: this.state.wallet.address,
      sender: this.state.wallet.address,
      signer: personalSign,
      hasher: sha256Hex,
      fetch: asJsonFetch,
      profile,
      apiHost: this.client.apiHost,
      crns: this.state.crns,
      crnListUrl: this.props.crnListUrl,
      preferSecureMetadata: profile === "uc-go-peer",
      current: {
        itemHash: args.itemHash,
        registrationId,
        peerId,
        probeMultiaddrs,
        browserBootstrapMultiaddrs,
      },
    });
    if (reconcileResult.errors.length > 0) {
      this.trace("deploy:owner-bootstrap-reconcile-errors", {
        itemHash: args.itemHash,
        errors: reconcileResult.errors,
      });
    }

    if (profile === "uc-go-peer" && args.deploymentToken) {
      await deleteVmBootstrapConfig({
        sender: this.state.wallet.address,
        deploymentToken: args.deploymentToken,
        signer: personalSign,
        hasher: sha256Hex,
        fetch: asJsonFetch,
        apiHost: this.client.apiHost,
        sync: true,
      }).catch((error) => {
        this.trace("deploy:bootstrap-config-cleanup-error", {
          itemHash: args.itemHash,
          deploymentToken: args.deploymentToken,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  private syncLatestDeploymentProgress(
    instances: CompactInstanceRecord[],
  ): void {
    const itemHash = this.state.lastDeploymentHash;
    if (!itemHash) {
      return;
    }

    const latest = instances.find(
      (entry) => entry.instance.item_hash === itemHash,
    );
    if (!latest) {
      return;
    }

    const currentProgress = this.state.deploymentProgress;
    const currentProgressIsForLatestHash =
      currentProgress.itemHash === itemHash ||
      (currentProgress.itemHash == null &&
        currentProgress.stage !== "idle" &&
        currentProgress.stage !== "error");

    const keepTerminalSuccess =
      this.lastRuntimeReadyHash === itemHash ||
      (currentProgressIsForLatestHash &&
        currentProgress.stage === "completed" &&
        currentProgress.status === "success");

    const status = latest.details.messageStatus;

    if (status === "rejected") {
      this.emitProgress({
        stage: "deployment-rejected",
        label: "Deployment rejected",
        progress: 100,
        status: "error",
        itemHash,
        detail: "Aleph rejected the deployment.",
        error: "Aleph rejected the deployment.",
      });
      return;
    }

    if (status !== "processed") {
      if (keepTerminalSuccess) {
        this.trace("progress:retain-completed", {
          reason: "latest refresh still reports non-processed status",
          itemHash,
          status,
        });
        return;
      }

      const submittedAtMs = instanceTimestampMs(latest.instance);
      const pendingTooLong =
        submittedAtMs != null &&
        Date.now() - submittedAtMs >= DEPLOYMENT_PENDING_WARNING_MS;

      this.emitProgress({
        stage: "waiting-for-aleph",
        label: pendingTooLong
          ? "Aleph processing delayed"
          : "Waiting for Aleph",
        progress: 76,
        status: pendingTooLong ? "warning" : "info",
        itemHash,
        detail: pendingTooLong
          ? "The instance is still pending on Aleph after several minutes. Retry, inspect the Aleph message, or delete and redeploy."
          : "Deployment submitted. Waiting for Aleph to process the instance message.",
      });
      return;
    }

    if (!hasUsableRuntime(latest.details)) {
      if (keepTerminalSuccess) {
        this.trace("progress:retain-completed", {
          reason: "latest refresh lacks runtime details after completed state",
          itemHash,
        });
        return;
      }

      this.emitProgress({
        stage: "deployment-confirmed",
        label: "Waiting for runtime",
        progress: 88,
        status: "warning",
        itemHash,
        detail:
          "Aleph processed the deployment. Waiting for scheduler/runtime allocation details.",
      });
      return;
    }

    this.emitProgress({
      stage: "completed",
      label: "Runtime ready",
      progress: 100,
      status: "success",
      itemHash,
      detail: "Deployment processed and runtime networking is available.",
    });
  }

  private canSkipRuntimeRefresh(instance: InstanceMessage): boolean {
    if (instance.item_hash === this.state.lastDeploymentHash) {
      return false;
    }

    const cooldownUntil = this.runtimeCooldownByHash.get(instance.item_hash);
    if (!cooldownUntil) {
      return false;
    }

    return cooldownUntil > Date.now();
  }

  private noteRuntimeRefreshResult(
    instance: InstanceMessage,
    details: CompactInstanceDetails,
  ): void {
    const hasRuntimeData =
      Boolean(details.crnUrl) ||
      Boolean(details.hostIpv4) ||
      Boolean(details.vmIpv4) ||
      details.mappedPorts.length > 0 ||
      Boolean(details.webUrl) ||
      Boolean(details.execution);

    if (
      hasRuntimeData ||
      details.error ||
      details.messageStatus !== "processed"
    ) {
      this.runtimeCooldownByHash.delete(instance.item_hash);
      return;
    }

    const timestampMs = instanceTimestampMs(instance);
    const isRecent =
      timestampMs != null &&
      Date.now() - timestampMs < RECENT_INSTANCE_RUNTIME_GRACE_MS;

    if (isRecent) {
      this.runtimeCooldownByHash.delete(instance.item_hash);
      return;
    }

    this.runtimeCooldownByHash.set(
      instance.item_hash,
      Date.now() + STALE_INSTANCE_ALLOCATION_COOLDOWN_MS,
    );
  }

  private rememberRuntimeDetails(
    itemHash: string,
    details: CompactInstanceDetails,
  ): void {
    if (!hasUsableRuntime(details)) {
      return;
    }

    this.runtimeDetailsByHash.set(itemHash, {
      ...details,
      mappedPorts: [...details.mappedPorts],
    });
  }

  private mergeRememberedRuntimeDetails(
    itemHash: string,
    details: CompactInstanceDetails,
  ): CompactInstanceDetails {
    const remembered = this.runtimeDetailsByHash.get(itemHash);
    if (!remembered) {
      return details;
    }

    if (details.messageStatus === "processed" && hasUsableRuntime(details)) {
      return details;
    }

    this.trace("runtime:retain-known-details", {
      itemHash,
      currentStatus: details.messageStatus,
      rememberedStatus: remembered.messageStatus,
      currentHasRuntime: hasUsableRuntime(details),
    });

    return {
      ...details,
      ...remembered,
      error: details.error ?? remembered.error,
    };
  }

  async init(): Promise<void> {
    this.trace("init:start", {
      launcherMode: this.props.launcherMode ?? "floating",
      manifestUrl: this.state.manifestUrl,
    });
    this.stopWalletWatch = watchWallet(() => {
      this.trace("wallet:changed");
      void this.refreshWalletDerivedState();
    });
    await this.refresh();
    this.refreshTimer = setInterval(() => {
      void this.refresh();
    }, REFRESH_INTERVAL_MS);
    this.pingTimer = setInterval(() => {
      void this.refreshRelayPing();
    }, RELAY_PING_INTERVAL_MS);
    await this.refreshRelayPing();
    this.patch({ ready: true });
    this.trace("init:ready");
  }

  destroy(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.manifestRefreshTimer) clearTimeout(this.manifestRefreshTimer);
    this.stopWalletWatch?.();
  }

  setOpen(open: boolean): void {
    this.patch({ open });
  }

  toggleOpen(): void {
    this.patch({ open: !this.state.open });
  }

  setManifestUrl(manifestUrl: string): void {
    this.patch({ manifestUrl });
    this.queueManifestRefresh();
  }

  setManifestJson(manifestJson: string): void {
    this.patch({
      manifestJson,
      showAdvanced: this.state.showAdvanced || Boolean(manifestJson.trim()),
      showPasteManifest: this.state.showPasteManifest || Boolean(manifestJson.trim()),
    });
    this.queueManifestRefresh();
  }

  setShowAdvanced(showAdvanced: boolean): void {
    this.patch({ showAdvanced });
  }

  setShowPasteManifest(showPasteManifest: boolean): void {
    this.patch({ showPasteManifest });
  }

  setSshPublicKey(sshPublicKey: string): void {
    this.patch({
      sshPublicKey,
      showAdvanced: this.state.showAdvanced || Boolean(sshPublicKey.trim()),
    });
  }

  setInstanceName(instanceName: string): void {
    this.patch({ instanceName });
  }

  setTierId(tierId: string): void {
    this.patch({ tierId });
    this.recomputePricingSummary();
  }

  private recomputePricingSummary() {
    const pricing = this.state.pricingSummary.pricing;
    const tier =
      pricing?.tiers.find((entry) => entry.id === this.state.tierId) ??
      pricing?.tiers[0] ??
      null;
    const balance = this.state.balance;
    const quote =
      pricing && tier && balance
        ? buildPaymentQuote(tier, pricing, balance)
        : null;
    const spec = pricing && tier ? tierSpec(pricing, tier) : null;
    const selectedCrn =
      compatibleCrnsForTier(this.state.crns, {
        ...this.state,
        pricingSummary: {
          ...this.state.pricingSummary,
          pricing,
          tier,
        },
      } as SponsorRelayState)[0] ?? null;

    this.patch({
      pricingSummary: {
        pricing,
        tier,
        requiredCredits: quote?.required ?? null,
        availableCredits: quote?.available ?? balance?.credit_balance ?? null,
        vcpus: spec?.vcpus ?? null,
        memoryMiB: spec?.memoryMiB ?? null,
        diskMiB: spec?.diskMiB ?? null,
      },
      selectedCrn,
    });
  }

  private queueManifestRefresh(): void {
    if (!this.state.ready) {
      return;
    }

    if (this.manifestRefreshTimer) {
      clearTimeout(this.manifestRefreshTimer);
    }

    // Debounce manifest-source updates so paste actions feel immediate
    // without triggering a full refresh for every individual keystroke.
    this.manifestRefreshTimer = setTimeout(() => {
      this.manifestRefreshTimer = null;
      void this.refresh();
    }, MANIFEST_SOURCE_REFRESH_DEBOUNCE_MS);
  }

  async connectWallet(): Promise<void> {
    this.patch({
      busy: { connectingWallet: true },
      errorText: null,
      statusText: "Connecting MetaMask",
    });

    try {
      const wallet = await connectWallet();
      this.patch({
        wallet,
        busy: { connectingWallet: false },
        statusText: "Wallet connected",
      });
      await this.refresh();
    } catch (error) {
      this.patch({
        busy: { connectingWallet: false },
        errorText: error instanceof Error ? error.message : String(error),
        statusText: "Wallet connection failed",
      });
    }
  }

  private async refreshWalletDerivedState(): Promise<void> {
    if (!this.state.wallet.connected) {
      return;
    }

    try {
      const wallet = await connectWallet();
      this.patch({ wallet });
      await this.refresh();
    } catch {
      this.patch({
        wallet: {
          connected: false,
          address: null,
          chainId: null,
          isMetaMask: false,
        },
      });
    }
  }

  async refresh(): Promise<void> {
    this.trace("refresh:start", {
      wallet: this.state.wallet.address,
      manifestUrl: this.state.manifestUrl,
      showInstances: this.state.showInstances,
    });
    this.patch({
      busy: { refreshing: true },
      errorText: null,
      statusText: "Refreshing relay sponsor data",
    });

    try {
      const [pricingSummary, crns] = await Promise.all([
        fetchInstancePricing(this.client.apiHost),
        this.client.fetchCrns(),
      ]);
      const manifestState = await resolveManifest({
        manifestUrl: this.state.manifestUrl,
        manifestJson: this.state.manifestJson,
      }).catch((error) => manifestLoadErrorState(error));
      const manifest = manifestState.manifest;

      let balance = this.state.balance;
      let instances: CompactInstanceRecord[] = [];
      if (this.state.wallet.address) {
        const [nextBalance, rawInstances] = await Promise.all([
          this.client.fetchBalance(this.state.wallet.address),
          this.state.showInstances
            ? this.client.fetchInstances(this.state.wallet.address)
            : Promise.resolve([]),
        ]);
        balance = nextBalance;
        instances = await Promise.all(
          rawInstances.map(async (instance) => {
            const inspected = this.canSkipRuntimeRefresh(instance)
              ? {
                  details: {
                  messageStatus: String(
                    instance.status ??
                      (instance.confirmed ? "processed" : "pending"),
                  ).toLowerCase(),
                  allocationSource: null,
                  crnUrl: null,
                  hostIpv4: null,
                  ipv6: null,
                  vmIpv4: null,
                  webUrl: null,
                  sshCommand: null,
                  mappedPorts: [],
                  execution: null,
                  error: null,
                  },
                  lookup: {
                    allocationFound: false,
                    allocationSource: null,
                    crnUrl: null,
                    webUrl: null,
                    executionPayloadFound: false,
                    executionLookupBlocked: false,
                    executionLookupRequestUrl: null,
                    executionLookupVersion: null,
                  },
                }
              : await inspectInstanceRuntime({
                  client: this.client,
                  instance,
                  crns,
                });
            const details = inspected.details;

            const mergedDetails = this.mergeRememberedRuntimeDetails(
              instance.item_hash,
              details,
            );
            if (
              this.debugEnabled &&
              instance.item_hash === this.state.lastDeploymentHash
            ) {
              this.trace("runtime:inspect-result", {
                itemHash: instance.item_hash,
                messageStatus: details.messageStatus,
                hostIpv4: details.hostIpv4,
                vmIpv4: details.vmIpv4,
                mappedPorts: details.mappedPorts,
                error: details.error,
                lookup: inspected.lookup,
              });
            }
            this.rememberRuntimeDetails(instance.item_hash, mergedDetails);
            this.noteRuntimeRefreshResult(instance, mergedDetails);

            return {
              instance,
              details: mergedDetails,
            };
          }),
        );
      }

      let rootfsVerified = false;
      let rootfsResolution = null;
      if (manifestState.valid && manifest) {
        rootfsVerified = await verifyRootfsExists(
          manifest.rootfsItemHash,
          this.client.apiHost,
        );
        rootfsResolution = await resolveRootfsReference(
          manifest.rootfsItemHash,
          this.client.apiHost,
        );
      }

      this.patch({
        manifestState,
        manifest,
        rootfsVerified,
        rootfsResolution,
        rootfsHealth: rootfsHealth({
          manifestState,
          rootfsVerified,
          resolution: rootfsResolution,
        }),
        pricingSummary: {
          ...this.state.pricingSummary,
          pricing: pricingSummary.pricing,
        },
        balance,
        crns,
        instances,
        busy: { refreshing: false },
        statusText: "Relay sponsor data ready",
      });
      this.trace("refresh:success", {
        manifestValid: manifestState.valid,
        rootfsVerified,
        instances: instances.length,
      });
      this.recomputePricingSummary();
      this.syncLatestDeploymentProgress(instances);
    } catch (error) {
      this.trace("refresh:error", error);
      this.patch({
        busy: { refreshing: false },
        errorText: error instanceof Error ? error.message : String(error),
        statusText: "Refresh failed",
      });
    }
  }

  async refreshRelayPing(): Promise<void> {
    const relayPing = await pingPeer(this.props.libp2p);
    this.patch({ relayPing });
    this.trace("libp2p:relay-ping", relayPing);
  }

  async deploy(): Promise<void> {
    this.trace("deploy:start", {
      wallet: this.state.wallet.address,
      instanceName: this.state.instanceName,
      tierId: this.state.tierId,
      selectedCrn: this.state.selectedCrn?.name ?? null,
      manifestRootfsItemHash: this.state.manifest?.rootfsItemHash ?? null,
      requiredPortForwards: this.state.manifest?.requiredPortForwards ?? [],
    });
    if (!this.state.wallet.address) {
      this.patch({ errorText: "Connect MetaMask before deploying." });
      return;
    }
    if (
      !this.state.manifest ||
      !this.state.rootfsVerified ||
      !this.state.pricingSummary.pricing ||
      !this.state.pricingSummary.tier
    ) {
      this.patch({
        errorText:
          "Manifest, rootfs, and pricing must be ready before deploying.",
      });
      return;
    }

    this.patch({
      busy: { deploying: true },
      errorText: null,
      statusText: "Broadcasting deployment",
    });

    try {
      this.emitProgress({
        stage: "validating",
        label: "Validating deployment",
        progress: 5,
        status: "info",
        detail: "Checking wallet, manifest, rootfs, pricing, and SSH key.",
      });
      const spec = tierSpec(
        this.state.pricingSummary.pricing,
        this.state.pricingSummary.tier,
      );
      const compatibleCrns = compatibleCrnsForTier(this.state.crns, {
        ...this.state,
        pricingSummary: {
          ...this.state.pricingSummary,
          pricing: this.state.pricingSummary.pricing,
          tier: this.state.pricingSummary.tier,
        },
      } as SponsorRelayState);
      const preferredCrnHash = this.state.selectedCrn?.hash ?? null;
      const orderedCrns = [
        ...compatibleCrns.filter((crn) => crn.hash === preferredCrnHash),
        ...compatibleCrns.filter((crn) => crn.hash !== preferredCrnHash),
      ].slice(0, 5);

      if (orderedCrns.length === 0) {
        throw new Error("No compatible CRN is currently available for this tier.");
      }

      const attemptErrors: string[] = [];
      let lastError: Error | null = null;

      for (const [candidateIndex, candidateCrn] of orderedCrns.entries()) {
        let attemptItemHash: string | null = null;
        let attemptDeploymentToken: string | null = null;

        this.emitProgress({
          stage: "selecting-crn",
          label: "Selecting CRN",
          progress: 18,
          status: "info",
          detail: `Trying ${candidateCrn.name ?? candidateCrn.hash} (${candidateIndex + 1}/${orderedCrns.length})`,
        });

        try {
          const profile = relayProfileForManifest(this.state.manifest);
          const sshPublicKey =
            profile === "uc-go-peer"
              ? appendDeploymentTokenToSshPublicKey(
                  this.state.sshPublicKey.trim(),
                  this.state.wallet.address,
                  (attemptDeploymentToken = createDeploymentToken()),
                )
              : this.state.sshPublicKey.trim();

          const content = createInstanceContent({
            address: this.state.wallet.address,
            name: this.state.instanceName.trim(),
            sshPublicKey,
            rootfsItemHash: this.state.manifest.rootfsItemHash,
            rootfsSizeMiB: Math.max(
              this.state.manifest.rootfsSizeMiB,
              spec.diskMiB,
            ),
            vcpus: spec.vcpus,
            memoryMiB: spec.memoryMiB,
            rootfsVersion: this.state.manifest.version,
            crnHash: candidateCrn.hash,
          });

          const result = await deploySharedInstance({
            sender: this.state.wallet.address,
            content,
            hasher: sha256Hex,
            signer: personalSign,
            fetch: (url, init) => fetch(url, init),
            apiHost: this.client.apiHost,
            sync: false,
            onProgress: (event) => {
              this.emitProgress(event);
            },
          });

          attemptItemHash = result.itemHash;
          this.patch({
            statusText: `Deployment submitted: ${result.itemHash}`,
            lastDeploymentHash: result.itemHash,
          });
          this.trace("deploy:broadcasted", {
            ...result,
            crnHash: candidateCrn.hash,
            crnName: candidateCrn.name,
          });
          this.lastRuntimeReadyHash = null;

          const inspection = await waitForDeploymentResult(result.itemHash, {
            rootfsRef: this.state.manifest.rootfsItemHash,
            apiHost: this.client.apiHost,
            fetch: (url, init) => fetch(url, init),
            attempts: UI_DEPLOY_WAIT_ATTEMPTS,
            delayMs: UI_DEPLOY_WAIT_DELAY_MS,
            onAttempt: (inspectionResult) => {
              if (inspectionResult.status === "processed") {
                this.emitProgress({
                  stage: "deployment-confirmed",
                  label: "Deployment accepted by Aleph",
                  progress: 82,
                  status: "success",
                  itemHash: result.itemHash,
                  detail: "Aleph processed the instance message.",
                });
                return;
              }

              if (inspectionResult.status === "rejected") {
                this.emitProgress({
                  stage: "deployment-rejected",
                  label: "Deployment rejected",
                  progress: 100,
                  status: "error",
                  itemHash: result.itemHash,
                  detail:
                    inspectionResult.rejectionReason ??
                    "Aleph rejected the deployment.",
                  error:
                    inspectionResult.rejectionReason ??
                    "Aleph rejected the deployment.",
                });
                return;
              }

              this.emitProgress({
                stage: "waiting-for-aleph",
                label: "Waiting for Aleph",
                progress: 76,
                status: "info",
                itemHash: result.itemHash,
                detail:
                  "Deployment submitted. Waiting for Aleph to process the instance message.",
              });
            },
          });

          if (inspection.status !== "processed") {
            throw new Error(
              inspection.rejectionReason ??
                `Deployment ${result.itemHash} stayed ${inspection.status} on Aleph.`,
            );
          }
          this.trace("deploy:aleph-processed", inspection);

          if ((this.state.manifest.requiredPortForwards?.length ?? 0) > 0) {
            this.emitProgress({
              stage: "refreshing-instances",
              label: "Publishing port forwards",
              progress: 86,
              status: "info",
              itemHash: result.itemHash,
              detail:
                "Publishing the required Aleph port-forward aggregate from the manifest.",
            });
            await ensureInstancePortForwards({
              sender: this.state.wallet.address,
              instanceItemHash: result.itemHash,
              manifest: toSharedRootfsManifest(this.state.manifest),
              signer: personalSign,
              hasher: sha256Hex,
              fetch: (url, init) => fetch(url, init),
              apiHost: this.client.apiHost,
              sync: true,
            });
            this.trace("deploy:port-forwards-published", {
              itemHash: result.itemHash,
              requiredPortForwards: this.state.manifest.requiredPortForwards,
            });
          }

          if (candidateCrn.address) {
            this.trace("deploy:notifying-crn", {
              itemHash: result.itemHash,
              crnName: candidateCrn.name,
              crnHash: candidateCrn.hash,
              crnUrl: candidateCrn.address,
            });
            await notifyCrnAllocationWithRetry({
              crnUrl: candidateCrn.address,
              itemHash: result.itemHash,
              fetch: (url, init) => fetch(url, init),
              onProgress: (event) => {
                this.emitProgress(event);
              },
            });
          }

          this.emitProgress({
            stage: "deployment-confirmed",
            label: "Waiting for runtime",
            progress: 90,
            status: "warning",
            itemHash: result.itemHash,
            detail:
              "Aleph accepted the deployment. Waiting for runtime networking and mapped ports.",
          });

          const runtime = await waitForVmRuntime({
            itemHash: result.itemHash,
            fetch: (url, init) => fetch(url, init),
            crnHash: candidateCrn.hash,
            crns: this.state.crns,
            crnListUrl: this.props.crnListUrl,
            attempts: UI_RUNTIME_WAIT_ATTEMPTS,
            delayMs: UI_RUNTIME_WAIT_DELAY_MS,
            onAttempt: (runtime) => {
              if (
                runtime.hostIpv4 &&
                Object.keys(runtime.mappedPorts ?? {}).length > 0
              ) {
                this.emitProgress({
                  stage: "completed",
                  label: "Runtime ready",
                  progress: 100,
                  status: "success",
                  itemHash: result.itemHash,
                  detail: "Runtime networking and mapped ports are now available.",
                });
                return;
              }

              this.emitProgress({
                stage: "deployment-confirmed",
                label: "Waiting for runtime",
                progress: 90,
                status: "warning",
                itemHash: result.itemHash,
                detail:
                  runtime.diagnostics?.reason ??
                  "Waiting for CRN runtime networking and mapped ports.",
              });
            },
          });

          if (
            !runtime.hostIpv4 ||
            Object.keys(runtime.mappedPorts ?? {}).length === 0
          ) {
            throw new Error(
              runtime.diagnostics?.reason ??
                "Deployment was processed, but runtime networking never exposed mapped ports.",
            );
          }
          this.trace("deploy:runtime-ready", runtime);
          this.lastRuntimeReadyHash = result.itemHash;
          this.rememberRuntimeDetails(result.itemHash, {
            messageStatus: "processed",
            allocationSource: runtime.allocation?.source ?? null,
            crnUrl:
              runtime.allocation?.crnUrl ??
              runtime.execution?.crnUrl ??
              null,
            hostIpv4: runtime.hostIpv4 ?? null,
            ipv6: runtime.ipv6 ?? null,
            vmIpv4: runtime.execution?.networking?.ipv4_ip ?? null,
            webUrl:
              runtime.webAccessUrl ??
              runtime.proxyUrl ??
              runtime.execution?.networking?.proxy_url ??
              null,
            sshCommand: runtime.sshCommand ?? null,
            mappedPorts:
              runtime.execution != null
                ? mappedPorts(runtime.execution)
                : runtimeMappedPorts(runtime.mappedPorts),
            execution: runtime.execution ?? null,
            error: null,
          });

          await this.configureRelayBootstrapRegistration({
            itemHash: result.itemHash,
            runtime,
            deploymentToken: attemptDeploymentToken,
          });

          this.patch({
            busy: { deploying: false },
          });

          this.emitProgress({
            stage: "refreshing-instances",
            label: "Refreshing instances",
            progress: 96,
            status: "info",
            itemHash: result.itemHash,
            detail: "Reloading deployments and runtime state.",
          });
          await this.refresh();
          return;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          const attemptLabel = candidateCrn.name ?? candidateCrn.hash;
          attemptErrors.push(`${attemptLabel}: ${lastError.message}`);
          this.trace("deploy:crn-attempt-error", {
            crnHash: candidateCrn.hash,
            crnName: candidateCrn.name,
            itemHash: attemptItemHash,
            error: lastError.message,
          });

          if (attemptItemHash) {
            if (attemptDeploymentToken) {
              this.trace("deploy:bootstrap-config-cleanup-start", {
                itemHash: attemptItemHash,
                deploymentToken: attemptDeploymentToken,
              });
              await deleteVmBootstrapConfig({
                sender: this.state.wallet.address,
                deploymentToken: attemptDeploymentToken,
                signer: personalSign,
                hasher: sha256Hex,
                fetch: asJsonFetch,
                apiHost: this.client.apiHost,
                sync: true,
              })
                .then((cleanupResult) => {
                  this.trace("deploy:bootstrap-config-cleanup-complete", {
                    itemHash: attemptItemHash,
                    deploymentToken: attemptDeploymentToken,
                    aggregateItemHash: cleanupResult.aggregateItemHash,
                    aggregateStatus: cleanupResult.aggregateStatus,
                  });
                })
                .catch((cleanupError) => {
                  this.trace("deploy:bootstrap-config-cleanup-error", {
                    itemHash: attemptItemHash,
                    deploymentToken: attemptDeploymentToken,
                    error:
                      cleanupError instanceof Error
                        ? cleanupError.message
                        : String(cleanupError),
                  });
                });
            }
            this.trace("deploy:forget-failed-attempt-start", {
              itemHash: attemptItemHash,
              crnHash: candidateCrn.hash,
              crnName: candidateCrn.name,
            });
            await forgetAlephMessages({
              sender: this.state.wallet.address,
              hashes: [attemptItemHash],
              reason: `Discard failed Sponsor Relay deployment attempt on ${attemptLabel}`,
              signer: personalSign,
              hasher: sha256Hex,
              fetch: (url, init) =>
                fetch(url, init).then(async (response) => ({
                  ok: response.ok,
                  status: response.status,
                  json: async () => await response.json(),
                })),
              apiHost: this.client.apiHost,
            }).catch((cleanupError) => {
              this.trace("deploy:cleanup-error", {
                itemHash: attemptItemHash,
                error:
                  cleanupError instanceof Error
                    ? cleanupError.message
                    : String(cleanupError),
              });
            });
            this.trace("deploy:forget-failed-attempt-complete", {
              itemHash: attemptItemHash,
              crnHash: candidateCrn.hash,
              crnName: candidateCrn.name,
            });
          }

          if (candidateIndex < orderedCrns.length - 1) {
            this.emitProgress({
              stage: "selecting-crn",
              label: "Retrying another CRN",
              progress: 20,
              status: "warning",
              itemHash: attemptItemHash,
              detail: `${attemptLabel} failed: ${lastError.message}`,
              error: lastError.message,
            });
            continue;
          }
        }
      }

      throw new Error(
        attemptErrors.length > 0
          ? `All compatible CRNs failed. ${attemptErrors.join(" | ")}`
          : (lastError?.message ?? "All compatible CRNs failed."),
      );
    } catch (error) {
      this.trace("deploy:error", error);
      this.patch({
        busy: { deploying: false },
        errorText: error instanceof Error ? error.message : String(error),
        statusText: "Deployment failed",
      });
      this.emitProgress({
        stage: "error",
        label: "Deployment failed",
        progress: 100,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async deleteInstance(instanceHash: string): Promise<void> {
    this.trace("delete:start", { instanceHash });
    if (!this.state.wallet.address) {
      this.patch({ errorText: "Connect MetaMask before deleting instances." });
      return;
    }

    this.patch({
      busy: { deletingInstanceHash: instanceHash },
      errorText: null,
      statusText: `Deleting ${instanceHash}`,
    });

    try {
      this.emitProgress({
        stage: "validating",
        label: "Validating delete request",
        progress: 6,
        status: "warning",
        itemHash: instanceHash,
        detail: "Preparing Aleph FORGET message.",
      });
      await forgetAlephMessages({
        sender: this.state.wallet.address,
        hashes: [instanceHash],
        reason: "Deleted from Sponsor Relay panel",
        signer: personalSign,
        hasher: sha256Hex,
        fetch: asJsonFetch,
        apiHost: this.client.apiHost,
        onProgress: (event) => {
          this.emitProgress(event);
        },
      });

      const profile = relayProfileForManifest(this.state.manifest);
      if (profile) {
        await reconcileOwnerRelayBootstrapRegistrations({
          instanceOwnerAddress: this.state.wallet.address,
          sender: this.state.wallet.address,
          signer: personalSign,
          hasher: sha256Hex,
          fetch: asJsonFetch,
          profile,
          apiHost: this.client.apiHost,
          crns: this.state.crns,
          crnListUrl: this.props.crnListUrl,
          preferSecureMetadata: profile === "uc-go-peer",
        }).catch(
          (error) => {
            this.trace("delete:owner-bootstrap-reconcile-error", {
              instanceHash,
              profile,
              error: error instanceof Error ? error.message : String(error),
            });
          },
        );
      }

      this.patch({
        busy: { deletingInstanceHash: null },
        statusText: `Deletion submitted for ${instanceHash}`,
      });
      this.emitProgress({
        stage: "refreshing-instances",
        label: "Refreshing instances after delete",
        progress: 92,
        status: "info",
        itemHash: instanceHash,
        detail: "Reloading current deployments.",
      });
      await this.refresh();
      this.trace("delete:submitted", { instanceHash });
      this.emitProgress({
        stage: "completed",
        label: "Delete completed",
        progress: 100,
        status: "success",
        itemHash: instanceHash,
        detail: "Delete request submitted and deployments refreshed.",
        error: null,
      });
    } catch (error) {
      this.trace("delete:error", error);
      this.patch({
        busy: { deletingInstanceHash: null },
        errorText: error instanceof Error ? error.message : String(error),
        statusText: "Delete failed",
      });
    }
  }
}

export function createSponsorRelayController(
  props: SponsorRelayProps = {},
): SponsorRelayController {
  return new SponsorRelayController(props);
}
