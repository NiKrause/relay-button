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
  VM_BOOTSTRAP_CONFIG_HISTORY_RETENTION_MS,
  deleteVmBootstrapConfig,
  deployInstance as deploySharedInstance,
  eraseInstanceOnCrn,
  ensureInstancePortForwards,
  fetchVmRuntime,
  fetchRelayMetadataForRuntime,
  filterDeployableCrns,
  forgetAlephMessages,
  listStaleVmBootstrapConfigAggregateMessageHashes,
  notifyCrnAllocationWithRetry,
  publishRelayBootstrapRegistration,
  publishVmBootstrapConfig,
  tierSpec,
  waitForRelayBootstrapRegistration,
  waitForDeploymentResult,
  waitForSetupEndpoint,
  waitForVmBootstrapConfigSignal,
  waitForVmRuntime,
} from "../../../core/src/index.ts";
import {
  fetchAlephBootstrapPosts,
  selectCurrentRelayBootstrapPosts,
} from "../../../aleph-bootstrap/src/index.ts";

import {
  DEFAULT_INSTANCE_NAME,
  DEFAULT_MANIFEST_URL,
  DEFAULT_TIER_ID,
  DEPLOYMENT_PENDING_WARNING_MS,
  IDLE_DEPLOYMENT_PROGRESS,
  MANIFEST_SOURCE_REFRESH_DEBOUNCE_MS,
  RECENT_INSTANCE_RUNTIME_GRACE_MS,
  REFRESH_INTERVAL_MS,
  ROOTFS_MISSING_STATE,
  STALE_INSTANCE_ALLOCATION_COOLDOWN_MS,
} from "./constants";
import { createDeploymentProgressEmitter } from "./events";
import { buildSshCommand } from "./format";
import { resolveManifestSource } from "./manifest-source";
import { connectWallet, personalSign, watchWallet } from "./wallet-controller";
import type {
  CompactBootstrapRegistrationRecord,
  CompactInstanceDetails,
  CompactInstanceRecord,
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
      deletingRegistrationHash: null,
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
    bootstrapRegistrations: [],
    orphanBootstrapRegistrations: [],
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
      detail:
        "The manifest points to a rootfs STORE message that Aleph cannot find. Check that the manifest URL is correct and that the referenced rootfs was not forgotten.",
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
    label: "manifest rootfs not deployable",
    detail:
      args.resolution.rejectionReason ??
      (args.resolution.messageType === "STORE"
        ? "This manifest points to a rootfs STORE message that exists but is not deployable anymore, for example because it was forgotten or replaced. Double-check the manifest URL."
        : "Aleph rejected the rootfs reference. Double-check that the manifest URL points to the intended current rootfs."),
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

function registrationIdInstanceItemHash(
  registrationId: string | null | undefined,
): string | null {
  const normalized = String(registrationId ?? "").trim();
  if (!normalized) return null;
  const parts = normalized
    .split(":")
    .map((part) => part.trim())
    .filter(Boolean);
  const candidate = parts.at(-1) ?? "";
  return /^[0-9a-f]{64}$/i.test(candidate) ? candidate : null;
}

function relayBootstrapInstanceItemHash(
  entry: {
    content?: {
      registrationId?: string;
      ownerAddress?: string;
      publisherAddress?: string;
      authorization?: {
        payload?: {
          instanceItemHash?: string;
          ownerAddress?: string;
          publisherAddress?: string;
        };
      };
    } | null;
  } | null | undefined,
): string | null {
  const authorizedInstanceItemHash =
    typeof entry?.content?.authorization?.payload?.instanceItemHash === "string"
      ? entry.content.authorization.payload.instanceItemHash.trim()
      : "";
  if (authorizedInstanceItemHash) {
    return authorizedInstanceItemHash;
  }
  return registrationIdInstanceItemHash(entry?.content?.registrationId);
}

function relayBootstrapMatchesCurrentWallet(
  entry: {
    address?: string | null;
    content?: {
      ownerAddress?: string;
      publisherAddress?: string;
      registrationId?: string;
      authorization?: {
        payload?: {
          ownerAddress?: string;
          publisherAddress?: string;
          instanceItemHash?: string;
        };
      };
    } | null;
  } | null | undefined,
  normalizedWalletAddress: string,
  activeInstanceHashes: Set<string>,
): boolean {
  const instanceItemHash = relayBootstrapInstanceItemHash(entry);
  if (instanceItemHash && activeInstanceHashes.has(instanceItemHash)) {
    return true;
  }

  const candidateAddresses = [
    entry?.address,
    entry?.content?.ownerAddress,
    entry?.content?.authorization?.payload?.ownerAddress,
    entry?.content?.publisherAddress,
    entry?.content?.authorization?.payload?.publisherAddress,
  ];

  return candidateAddresses.some(
    (value) =>
      typeof value === "string" && value.trim().toLowerCase() === normalizedWalletAddress,
  );
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

  if (details.messageStatus === "rejected") {
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

const UI_DEPLOY_WAIT_ATTEMPTS = 60;
const UI_DEPLOY_WAIT_DELAY_MS = 5_000;
const UI_RUNTIME_WAIT_ATTEMPTS = 40;
const UI_RUNTIME_WAIT_DELAY_MS = 5_000;

type SponsorRelayStatePatch = Omit<
  Partial<SponsorRelayState>,
  "busy" | "wallet" | "pricingSummary"
> & {
  busy?: Partial<SponsorRelayState["busy"]>;
  wallet?: Partial<SponsorRelayState["wallet"]>;
  pricingSummary?: Partial<SponsorRelayState["pricingSummary"]>;
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
  private manifestRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private stopWalletWatch: (() => void) | null = null;
  private props: SponsorRelayProps;
  private progressEmitter = createDeploymentProgressEmitter();
  private runtimeCooldownByHash = new Map<string, number>();
  private runtimeDetailsByHash = new Map<string, CompactInstanceDetails>();
  private debugEnabled: boolean;
  private lastCompletedDeploymentHash: string | null = null;

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

    let runtime = args.runtime;
    let mappedPorts = runtime.mappedPorts ?? {};
    const setupPort = mappedPorts["80"]?.host ?? null;
    if (!setupPort) {
      throw new Error("Relay runtime did not expose the temporary setup endpoint.");
    }

    let bootstrapSignalRelayMetadata: {
      peerId: string;
      probeMultiaddrs: string[];
      browserBootstrapMultiaddrs: string[];
    } | null = null;

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
        onAttempt: (result, attempt, attempts) => {
          this.emitProgress({
            stage: "deployment-confirmed",
            label: "Waiting for guest setup",
            progress: 93,
            status: result.ok ? "success" : "info",
            itemHash: args.itemHash,
            detail: result.ok
              ? `Setup endpoint ${attempt}/${attempts}: ready at http://${args.runtime.hostIpv4}:${setupPort}/health.`
              : `Setup endpoint ${attempt}/${attempts}: waiting for http://${args.runtime.hostIpv4}:${setupPort}/health.`,
          });
        },
      });
      if (!setupHealth.ok) {
        throw new Error(
          `Relay setup endpoint did not become reachable at http://${args.runtime.hostIpv4}:${setupPort}/health.`,
        );
      }

      this.emitProgress({
        stage: "deployment-confirmed",
        label: "Applying relay networking",
        progress: 93,
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

      if (runtime.proxyUrl && runtime.webAccess?.active !== true) {
        this.emitProgress({
          stage: "deployment-confirmed",
          label: "Waiting for HTTPS route",
          progress: 93,
          status: "warning",
          itemHash: args.itemHash,
          detail:
            "The relay received a 2n6 hostname, but it is not active yet. Waiting before handing HTTPS config to the guest.",
        });

        let latestRuntime = runtime;
        for (let attempt = 0; attempt < UI_RUNTIME_WAIT_ATTEMPTS; attempt += 1) {
          if (latestRuntime.webAccess?.active === true) {
            break;
          }

          await new Promise((resolve) =>
            globalThis.setTimeout(resolve, UI_RUNTIME_WAIT_DELAY_MS),
          );
          latestRuntime = await fetchVmRuntime({
            itemHash: args.itemHash,
            fetch: (url, init) => fetch(url, init),
            crnHash:
              runtime.selectedCrn?.hash ??
              runtime.allocation?.crnHash ??
              undefined,
            crns: this.state.crns,
            crnListUrl: this.props.crnListUrl,
            requirePublicGuestIpv6ForProxy: true,
          }).catch(() => latestRuntime);
          this.emitProgress({
            stage: "deployment-confirmed",
            label: "Waiting for HTTPS route",
            progress: 93,
            status:
              latestRuntime.webAccess?.active === true ? "info" : "warning",
            itemHash: args.itemHash,
            detail:
              `2n6 activation ${attempt + 1}/${UI_RUNTIME_WAIT_ATTEMPTS}: ` +
              `${latestRuntime.webAccess?.active === true ? "active" : "still pending"} ` +
              `for ${latestRuntime.proxyUrl ?? runtime.proxyUrl ?? "reserved proxy URL"}.`,
          });
          this.trace("deploy:bootstrap-proxy-activation", {
            itemHash: args.itemHash,
            attempt: attempt + 1,
            attempts: UI_RUNTIME_WAIT_ATTEMPTS,
            active: latestRuntime.webAccess?.active === true,
            proxyUrl: latestRuntime.proxyUrl ?? null,
          });
        }

        runtime = latestRuntime;
        mappedPorts = runtime.mappedPorts ?? mappedPorts;
      }

      if (!runtime.hostIpv4) {
        throw new Error(
          "Relay runtime lost its host IPv4 address while waiting for HTTPS activation.",
        );
      }

      const runtimeHostIpv4 = runtime.hostIpv4;
      const activeProxyUrl =
        runtime.webAccess?.active === true ? (runtime.proxyUrl ?? null) : null;

      this.emitProgress({
        stage: "deployment-confirmed",
        label: "Publishing relay config",
        progress: 93,
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
          publicIpv4: runtimeHostIpv4,
          publicIpv6: runtime.ipv6 ?? null,
          proxyUrl: activeProxyUrl,
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

      this.emitProgress({
        stage: "deployment-confirmed",
        label: "Waiting for guest config",
        progress: 94,
        status: "info",
        itemHash: args.itemHash,
        detail:
          "Waiting for the relay VM to acknowledge that it consumed the Aleph bootstrap config.",
      });

      const bootstrapConfigSignal = await waitForVmBootstrapConfigSignal({
        deploymentToken: args.deploymentToken,
        ownerAddress: this.state.wallet.address,
        instanceItemHash: args.itemHash,
        fetch: asJsonFetch,
        apiHost: this.client.apiHost,
        attempts: 40,
        delayMs: 3000,
      });

      this.trace("deploy:bootstrap-config-signal-visible", {
        itemHash: args.itemHash,
        deploymentToken: args.deploymentToken,
        bootstrapConfigSignal,
      });

      if (!bootstrapConfigSignal) {
        throw new Error(
          "The relay VM did not confirm that it applied the Aleph bootstrap config in time.",
        );
      }

      bootstrapSignalRelayMetadata =
        typeof bootstrapConfigSignal.peerId === "string" &&
        bootstrapConfigSignal.peerId.length > 0 &&
        Array.isArray(bootstrapConfigSignal.probeMultiaddrs) &&
        bootstrapConfigSignal.probeMultiaddrs.length > 0
          ? {
              peerId: bootstrapConfigSignal.peerId,
              probeMultiaddrs: bootstrapConfigSignal.probeMultiaddrs,
              browserBootstrapMultiaddrs:
                bootstrapConfigSignal.browserBootstrapMultiaddrs ?? [],
            }
          : null;

      if (runtime.proxyUrl && runtime.webAccess?.active !== true) {
        this.trace("deploy:bootstrap-proxy-fallback", {
          itemHash: args.itemHash,
          deploymentToken: args.deploymentToken,
          proxyUrl: runtime.proxyUrl,
          bootstrapSignalRelayMetadata,
        });
        this.emitProgress({
          stage: "deployment-confirmed",
          label: "Continuing without HTTPS route",
          progress: 94,
          status: "warning",
          itemHash: args.itemHash,
          detail:
            "The 2n6 HTTPS route stayed inactive, so guest setup continued without Caddy. Secure browser routing can be enabled later when the proxy becomes available.",
        });
        runtime = {
          ...runtime,
          proxyUrl: null,
          webAccess: runtime.webAccess
            ? {
                ...runtime.webAccess,
                active: false,
              }
            : runtime.webAccess,
        };
      }
    }

    let relayMetadata = bootstrapSignalRelayMetadata;
    if (relayMetadata) {
      this.trace("deploy:relay-metadata-from-bootstrap-signal", {
        itemHash: args.itemHash,
        peerId: relayMetadata.peerId,
        probeMultiaddrCount: relayMetadata.probeMultiaddrs.length,
        browserBootstrapMultiaddrCount:
          relayMetadata.browserBootstrapMultiaddrs.length,
      });
    } else {
      this.emitProgress({
        stage: "publishing-bootstrap",
        label: "Waiting for secure relay metadata",
        progress: 95,
        status: "warning",
        itemHash: args.itemHash,
        detail:
          "Runtime networking is available. Waiting for the secure relay metadata endpoint to report final public multiaddrs.",
      });

      relayMetadata = await fetchRelayMetadataForRuntime({
        runtime,
        fetch: (url, init) => fetch(url, init),
        preferSecureMetadata: profile === "uc-go-peer" && Boolean(runtime.proxyUrl),
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
          this.emitProgress({
            stage: "publishing-bootstrap",
            label: result.ready
              ? "Secure relay metadata ready"
              : "Waiting for secure relay metadata",
            progress: 95,
            status: result.ready ? "success" : "warning",
            itemHash: args.itemHash,
            detail: result.ready
              ? `Relay metadata ${result.attempt}/${result.attempts}: secure endpoint responded and public multiaddrs are available.`
              : `Relay metadata ${result.attempt}/${result.attempts}: waiting for ${result.metadataUrl}.`,
          });
        },
      });
    }
    if (!relayMetadata) {
      await this.refresh().catch(() => undefined);

      const confirmedAfterRefresh = this.state.bootstrapRegistrations.some(
        (entry) => entry.instanceItemHash === args.itemHash && entry.confirmed,
      );

      if (confirmedAfterRefresh) {
        this.trace("deploy:relay-metadata-recovered-from-refresh", {
          itemHash: args.itemHash,
        });
        return;
      }

      throw new Error("Relay metadata did not include a peer ID and public multiaddrs.");
    }

    const { peerId } = relayMetadata;
    const registrationId = createRelayBootstrapRegistrationId(
      profile,
      this.state.instanceName.trim(),
      args.itemHash,
    );

    this.emitProgress({
      stage: "publishing-bootstrap",
      label: "Waiting for guest bootstrap registration",
      progress: 97,
      status: "info",
      itemHash: args.itemHash,
      detail: "Waiting for the relay VM to publish its own bootstrap registration to Aleph.",
    });

    const visibleRegistration = await waitForRelayBootstrapRegistration({
      registrationId,
      peerId,
      fetch: asJsonFetch,
      apiHost: this.client.apiHost,
      attempts: 24,
      delayMs: 2500,
      onAttempt: (match, attempt, attempts) => {
        this.emitProgress({
          stage: "publishing-bootstrap",
          label: "Waiting for guest bootstrap registration",
          progress: 97,
          status: match ? "success" : "info",
          itemHash: args.itemHash,
          detail: match
            ? `Guest bootstrap registration ${attempt}/${attempts}: visible on Aleph.`
            : `Guest bootstrap registration ${attempt}/${attempts}: still waiting for the relay VM registration on Aleph.`,
        });
      },
    });

    this.trace("deploy:bootstrap-registration-visible", {
      itemHash: args.itemHash,
      registrationId,
      peerId,
      visibleRegistration,
    });

    if (!visibleRegistration) {
      this.trace("deploy:bootstrap-registration-fallback-start", {
        itemHash: args.itemHash,
        registrationId,
        peerId,
        probeMultiaddrCount: relayMetadata.probeMultiaddrs.length,
        browserBootstrapMultiaddrCount:
          relayMetadata.browserBootstrapMultiaddrs.length,
      });
      this.emitProgress({
        stage: "publishing-bootstrap",
        label: "Publishing bootstrap fallback",
        progress: 98,
        status: "warning",
        itemHash: args.itemHash,
        detail:
          "Guest bootstrap registration was delayed. Publishing the relay bootstrap record from the browser.",
      });

      const fallbackPublication = await publishRelayBootstrapRegistration({
        sender: this.state.wallet.address,
        signer: personalSign,
        hasher: sha256Hex,
        fetch: asJsonFetch,
        apiHost: this.client.apiHost,
        peerId,
        multiaddrs: relayMetadata.probeMultiaddrs,
        browserMultiaddrs: relayMetadata.browserBootstrapMultiaddrs,
        registrationId,
        profile,
        sync: true,
        forgetPrevious: true,
      });
      this.trace("deploy:bootstrap-registration-fallback-published", {
        itemHash: args.itemHash,
        registrationId,
        peerId,
        fallbackPublication,
      });

      const fallbackVisibleRegistration = await waitForRelayBootstrapRegistration({
        sender: this.state.wallet.address,
        registrationId,
        peerId,
        fetch: asJsonFetch,
        apiHost: this.client.apiHost,
        attempts: 24,
        delayMs: 2500,
        onAttempt: (match, attempt, attempts) => {
          this.emitProgress({
            stage: "publishing-bootstrap",
            label: "Waiting for bootstrap fallback",
            progress: 98,
            status: match ? "success" : "warning",
            itemHash: args.itemHash,
            detail: match
              ? `Bootstrap fallback ${attempt}/${attempts}: visible on Aleph.`
              : `Bootstrap fallback ${attempt}/${attempts}: waiting for the browser-published registration on Aleph.`,
          });
        },
      });
      this.trace("deploy:bootstrap-registration-fallback-visible", {
        itemHash: args.itemHash,
        registrationId,
        peerId,
        fallbackVisibleRegistration,
      });

      if (!fallbackVisibleRegistration) {
        throw new Error(
          "Relay bootstrap registration did not become visible on Aleph.",
        );
      }
    }

    if (profile === "uc-go-peer" && args.deploymentToken) {
      let cleanupAggregateItemHash: string | null = null;
      await deleteVmBootstrapConfig({
        sender: this.state.wallet.address,
        deploymentToken: args.deploymentToken,
        signer: personalSign,
        hasher: sha256Hex,
        fetch: asJsonFetch,
        apiHost: this.client.apiHost,
        sync: true,
      })
        .then((cleanupResult) => {
          cleanupAggregateItemHash = cleanupResult.aggregateItemHash;
          this.trace("deploy:bootstrap-config-cleanup-complete", {
            itemHash: args.itemHash,
            deploymentToken: args.deploymentToken,
            aggregateItemHash: cleanupResult.aggregateItemHash,
            aggregateStatus: cleanupResult.aggregateStatus,
          });
        })
        .catch((error) => {
          this.trace("deploy:bootstrap-config-cleanup-error", {
            itemHash: args.itemHash,
            deploymentToken: args.deploymentToken,
            error: error instanceof Error ? error.message : String(error),
          });
        });

      await this.cleanupStaleVmBootstrapConfigHistory({
        itemHash: args.itemHash,
        currentAggregateItemHash: cleanupAggregateItemHash,
        stage: "publishing-bootstrap",
        progress: 99,
      });
    }
  }

  private async cleanupStaleVmBootstrapConfigHistory(args: {
    itemHash: string;
    currentAggregateItemHash?: string | null;
    stage: DeploymentProgressEvent["stage"];
    progress: number;
  }): Promise<void> {
    if (!this.state.wallet.address || !args.currentAggregateItemHash) {
      return;
    }

    const staleHashes = await listStaleVmBootstrapConfigAggregateMessageHashes({
      address: this.state.wallet.address,
      currentAggregateItemHash: args.currentAggregateItemHash,
      olderThanMs: VM_BOOTSTRAP_CONFIG_HISTORY_RETENTION_MS,
      fetch: asJsonFetch,
      apiHost: this.client.apiHost,
    }).catch((error) => {
      this.trace("deploy:bootstrap-config-history-scan-error", {
        itemHash: args.itemHash,
        currentAggregateItemHash: args.currentAggregateItemHash,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    });

    if (staleHashes.length === 0) {
      return;
    }

    const staleCount = staleHashes.length;
    this.emitProgress({
      stage: args.stage,
      label: "Cleaning up stale handoff history",
      progress: args.progress,
      status: "warning",
      itemHash: args.itemHash,
      detail:
        `Forgetting ${staleCount} superseded Aleph handoff aggregate message${staleCount === 1 ? "" : "s"} ` +
        "older than 6 hours. MetaMask may request another cleanup signature.",
    });
    this.trace("deploy:bootstrap-config-history-cleanup-start", {
      itemHash: args.itemHash,
      currentAggregateItemHash: args.currentAggregateItemHash,
      staleHashes,
    });

    await forgetAlephMessages({
      sender: this.state.wallet.address,
      hashes: staleHashes,
      reason: "Prune stale vm-bootstrap-config aggregate history older than 6 hours",
      signer: personalSign,
      hasher: sha256Hex,
      fetch: asJsonFetch,
      apiHost: this.client.apiHost,
      sync: true,
    })
      .then((cleanupResult) => {
        this.trace("deploy:bootstrap-config-history-cleanup-complete", {
          itemHash: args.itemHash,
          currentAggregateItemHash: args.currentAggregateItemHash,
          staleHashes,
          forgetItemHash: cleanupResult.itemHash,
          forgetStatus: cleanupResult.status,
        });
      })
      .catch((error) => {
        this.trace("deploy:bootstrap-config-history-cleanup-error", {
          itemHash: args.itemHash,
          currentAggregateItemHash: args.currentAggregateItemHash,
          staleHashes,
          error: error instanceof Error ? error.message : String(error),
        });
      });
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
      this.lastCompletedDeploymentHash === itemHash ||
      (currentProgressIsForLatestHash &&
        currentProgress.stage === "completed" &&
        currentProgress.status === "success");

    if (
      currentProgressIsForLatestHash &&
      currentProgress.stage === "publishing-bootstrap"
    ) {
      this.trace("progress:retain-active-phase", {
        reason:
          "latest refresh would overwrite active relay metadata/bootstrap progress",
        itemHash,
        label: currentProgress.label,
        progress: currentProgress.progress,
      });
      return;
    }

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

    const hasConfirmedBootstrapRegistration = this.state.bootstrapRegistrations.some(
      (entry) => entry.instanceItemHash === itemHash && entry.confirmed,
    );

    if (hasConfirmedBootstrapRegistration) {
      this.emitProgress({
        stage: "completed",
        label: "Relay ready",
        progress: 100,
        status: "success",
        itemHash,
        detail:
          "Runtime networking is available and the relay bootstrap registration is confirmed on Aleph.",
      });
      return;
    }

    this.emitProgress({
      stage: "deployment-confirmed",
      label: "Runtime ready",
      progress: 92,
      status: "info",
      itemHash,
      detail:
        "Deployment processed and runtime networking is available. Finishing relay setup and bootstrap verification.",
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
    this.patch({ ready: true });
    this.trace("init:ready");
  }

  destroy(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
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
      let bootstrapRegistrations: CompactBootstrapRegistrationRecord[] = [];
      let orphanBootstrapRegistrations: CompactBootstrapRegistrationRecord[] = [];
      if (this.state.wallet.address) {
        const [nextBalance, rawInstances, rawBootstrapPosts] = await Promise.all([
          this.client.fetchBalance(this.state.wallet.address),
          this.state.showInstances
            ? this.client.fetchInstances(this.state.wallet.address)
            : Promise.resolve([]),
          fetchAlephBootstrapPosts({
            apiHost: this.client.apiHost,
            fetch,
          }).catch(() => []),
        ]);
        balance = nextBalance;
        instances = await Promise.all(
          rawInstances.map(async (instance: InstanceMessage) => {
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
        const normalizedWalletAddress = this.state.wallet.address.toLowerCase();
        const activeInstanceHashes = new Set(
          instances.map((entry) => entry.instance.item_hash),
        );
        bootstrapRegistrations = selectCurrentRelayBootstrapPosts(rawBootstrapPosts)
          .filter(
            (entry): boolean =>
              relayBootstrapMatchesCurrentWallet(
                entry,
                normalizedWalletAddress,
                activeInstanceHashes,
              ),
          )
          .map((entry): CompactBootstrapRegistrationRecord => {
            const instanceItemHash = relayBootstrapInstanceItemHash(entry);
            const messageHash = entry.itemHash ?? entry.hash ?? null;
            return {
              messageHash,
              hash: entry.hash ?? null,
              itemHash: entry.itemHash ?? null,
              address: entry.address ?? null,
              time: entry.time ?? null,
              instanceItemHash,
              confirmed: Boolean(
                instanceItemHash && activeInstanceHashes.has(instanceItemHash),
              ),
              content: entry.content
                ? {
                    peerId: entry.content.peerId,
                    registrationId: entry.content.registrationId,
                    multiaddrs: Array.isArray(entry.content.multiaddrs)
                      ? entry.content.multiaddrs
                      : [],
                    browserMultiaddrs: Array.isArray(entry.content.browserMultiaddrs)
                      ? entry.content.browserMultiaddrs
                      : [],
                    ownerAddress:
                      typeof entry.content.ownerAddress === "string"
                        ? entry.content.ownerAddress
                        : undefined,
                    publisherAddress:
                      typeof entry.content.publisherAddress === "string"
                        ? entry.content.publisherAddress
                        : undefined,
                    updatedAt: entry.content.updatedAt,
                  }
                : null,
            };
          });
        orphanBootstrapRegistrations = bootstrapRegistrations.filter(
          (entry) => !entry.confirmed,
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
        bootstrapRegistrations,
        orphanBootstrapRegistrations,
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
      this.state.rootfsHealth.tone !== "ok" ||
      !this.state.pricingSummary.pricing ||
      !this.state.pricingSummary.tier
    ) {
      this.patch({
        errorText:
          this.state.rootfsHealth.tone === "error"
            ? `Cannot deploy: ${this.state.rootfsHealth.detail ?? this.state.rootfsHealth.label}`
            : "Manifest, rootfs, and pricing must be ready before deploying.",
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
        let attemptProfile: ReturnType<typeof relayProfileForManifest> = null;
        const crnAttemptLabel = `CRN ${candidateIndex + 1}/${orderedCrns.length}`;
        const crnDisplayName = candidateCrn.name ?? candidateCrn.hash;

        this.emitProgress({
          stage: "selecting-crn",
          label: `Selecting ${crnAttemptLabel}`,
          progress: 18,
          status: "info",
          detail: `Trying ${crnDisplayName}`,
        });

        try {
          const profile = relayProfileForManifest(this.state.manifest);
          attemptProfile = profile;
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
          this.lastCompletedDeploymentHash = null;

          const inspection = await waitForDeploymentResult(result.itemHash, {
            rootfsRef: this.state.manifest.rootfsItemHash,
            apiHost: this.client.apiHost,
            fetch: (url, init) => fetch(url, init),
            attempts: UI_DEPLOY_WAIT_ATTEMPTS,
            delayMs: UI_DEPLOY_WAIT_DELAY_MS,
            onAttempt: (inspectionResult, attempt, attempts) => {
              if (inspectionResult.status === "processed") {
                this.emitProgress({
                  stage: "deployment-confirmed",
                  label: "Deployment accepted by Aleph",
                  progress: 82,
                  status: "success",
                  itemHash: result.itemHash,
                  detail: `Aleph processing ${attempt}/${attempts}: instance message processed.`,
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
                detail: `Aleph processing ${attempt}/${attempts}: waiting for the instance message to be processed.`,
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
            requirePublicGuestIpv6ForProxy: true,
            attempts: UI_RUNTIME_WAIT_ATTEMPTS,
            delayMs: UI_RUNTIME_WAIT_DELAY_MS,
            onAttempt: (runtime, attempt, attempts) => {
              if (runtime.diagnostics?.state === "ready") {
                this.emitProgress({
                  stage: "deployment-confirmed",
                  label: "Runtime ready",
                  progress: 92,
                  status: "info",
                  itemHash: result.itemHash,
                  detail: `Runtime ${attempt}/${attempts}: networking and mapped ports are now available.`,
                });
                return;
              }

              if (runtime.diagnostics?.state === "execution-invalid-public-ipv6") {
                this.emitProgress({
                  stage: "deployment-confirmed",
                  label: "Rejecting unusable runtime",
                  progress: 91,
                  status: "warning",
                  itemHash: result.itemHash,
                  detail: runtime.diagnostics?.reason
                    ? `Runtime ${attempt}/${attempts}: ${runtime.diagnostics.reason} Cleaning up this CRN attempt before retrying another relay host.`
                    : `Runtime ${attempt}/${attempts}: the CRN exposed unusable guest networking. Cleaning up this CRN attempt before retrying another relay host.`,
                });
                return;
              }

              this.emitProgress({
                stage: "deployment-confirmed",
                label: "Waiting for runtime",
                progress: 90,
                status: "warning",
                itemHash: result.itemHash,
                detail: runtime.diagnostics?.reason
                  ? `Runtime ${attempt}/${attempts}: ${runtime.diagnostics.reason}`
                  : `Runtime ${attempt}/${attempts}: waiting for CRN runtime networking and mapped ports.`,
              });
            },
          });

          if (runtime.diagnostics?.state !== "ready") {
            throw new Error(
              runtime.diagnostics?.reason ??
                "Deployment was processed, but runtime networking never exposed mapped ports.",
            );
          }
          this.trace("deploy:runtime-ready", runtime);
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
            progress: 99,
            status: "info",
            itemHash: result.itemHash,
            detail: "Reloading deployments and runtime state.",
          });
          await this.refresh();
          this.lastCompletedDeploymentHash = result.itemHash;
          this.emitProgress({
            stage: "completed",
            label: "Relay ready",
            progress: 100,
            status: "success",
            itemHash: result.itemHash,
            detail:
              "Relay runtime, setup, metadata, and bootstrap registration are confirmed.",
          });
          return;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          const attemptLabel = crnDisplayName;
          const failedDueToInvalidIpv6 = /not globally routable|public guest IPv6/i.test(lastError.message);
          attemptErrors.push(`${attemptLabel}: ${lastError.message}`);
          this.trace("deploy:crn-attempt-error", {
            crnHash: candidateCrn.hash,
            crnName: candidateCrn.name,
            itemHash: attemptItemHash,
            error: lastError.message,
          });

          if (
            attemptItemHash &&
            attemptDeploymentToken &&
            attemptProfile &&
            !failedDueToInvalidIpv6
          ) {
            try {
              const latestRuntime = await fetchVmRuntime({
                itemHash: attemptItemHash,
                fetch: (url, init) => fetch(url, init),
                crnHash: candidateCrn.hash,
                crns: this.state.crns,
                crnListUrl: this.props.crnListUrl,
                requirePublicGuestIpv6ForProxy: true,
              });

              if (latestRuntime.diagnostics?.state === "ready") {
                const reconciledRelayMetadata = await fetchRelayMetadataForRuntime({
                  runtime: latestRuntime,
                  fetch: (url, init) => fetch(url, init),
                  preferSecureMetadata:
                    attemptProfile === "uc-go-peer" && Boolean(latestRuntime.proxyUrl),
                  attempts: 3,
                  delayMs: 1000,
                  timeoutMs: 15000,
                }).catch(() => null);

                if (reconciledRelayMetadata) {
                  const registrationId = createRelayBootstrapRegistrationId(
                    attemptProfile,
                    this.state.instanceName.trim(),
                    attemptItemHash,
                  );
                  const visibleRegistration =
                    await waitForRelayBootstrapRegistration({
                      registrationId,
                      peerId: reconciledRelayMetadata.peerId,
                      fetch: asJsonFetch,
                      apiHost: this.client.apiHost,
                      attempts: 3,
                      delayMs: 1000,
                    }).catch(() => null);

                  if (visibleRegistration) {
                    this.trace("deploy:recovered-after-error", {
                      itemHash: attemptItemHash,
                      registrationId,
                      peerId: reconciledRelayMetadata.peerId,
                      error: lastError.message,
                    });
                    this.rememberRuntimeDetails(attemptItemHash, {
                      messageStatus: "processed",
                      allocationSource: latestRuntime.allocation?.source ?? null,
                      crnUrl:
                        latestRuntime.allocation?.crnUrl ??
                        latestRuntime.execution?.crnUrl ??
                        null,
                      hostIpv4: latestRuntime.hostIpv4 ?? null,
                      ipv6: latestRuntime.ipv6 ?? null,
                      vmIpv4: latestRuntime.execution?.networking?.ipv4_ip ?? null,
                      webUrl:
                        latestRuntime.webAccessUrl ??
                        latestRuntime.proxyUrl ??
                        latestRuntime.execution?.networking?.proxy_url ??
                        null,
                      sshCommand: latestRuntime.sshCommand ?? null,
                      mappedPorts:
                        latestRuntime.execution != null
                          ? mappedPorts(latestRuntime.execution)
                          : runtimeMappedPorts(latestRuntime.mappedPorts),
                      execution: latestRuntime.execution ?? null,
                      error: null,
                    });
                    this.patch({
                      busy: { deploying: false },
                    });
                    await this.refresh();
                    this.lastCompletedDeploymentHash = attemptItemHash;
                    this.emitProgress({
                      stage: "completed",
                      label: "Relay ready",
                      progress: 100,
                      status: "success",
                      itemHash: attemptItemHash,
                      detail:
                        "The relay completed startup after a transient UI polling error. Runtime and bootstrap registration are confirmed.",
                    });
                    return;
                  }
                }
              }
            } catch (reconcileError) {
              this.trace("deploy:recovery-check-error", {
                itemHash: attemptItemHash,
                error:
                  reconcileError instanceof Error
                    ? reconcileError.message
                    : String(reconcileError),
              });
            }

            await this.refresh().catch(() => undefined);
            const recoveredRegistration = this.state.bootstrapRegistrations.some(
              (entry) =>
                entry.instanceItemHash === attemptItemHash && entry.confirmed,
            );

            if (recoveredRegistration) {
              this.trace("deploy:recovered-from-refresh-state", {
                itemHash: attemptItemHash,
                error: lastError.message,
              });
              this.patch({
                busy: { deploying: false },
              });
              this.lastCompletedDeploymentHash = attemptItemHash;
              this.emitProgress({
                stage: "completed",
                label: "Relay ready",
                progress: 100,
                status: "success",
                itemHash: attemptItemHash,
                detail:
                  "The relay completed startup after a transient browser-side polling error. Runtime and bootstrap registration are confirmed.",
              });
              return;
            }
          }

          if (attemptItemHash) {
            this.emitProgress({
              stage: "deployment-confirmed",
              label: failedDueToInvalidIpv6 ? "Rejecting unusable runtime" : "Cleaning up failed attempt",
              progress: failedDueToInvalidIpv6 ? 91 : 16,
              status: "warning",
              itemHash: attemptItemHash,
              detail: failedDueToInvalidIpv6
                ? `${attemptLabel} exposed runtime networking that cannot support proxy-backed HTTPS. Cleaning up this attempt before retrying another CRN.`
                : `${attemptLabel} failed: ${lastError.message} Cleaning up this attempt before retrying another CRN.`,
            });
            if (attemptDeploymentToken) {
              let cleanupAggregateItemHash: string | null = null;
              this.emitProgress({
                stage: "deployment-confirmed",
                label: "Cleaning up failed attempt",
                progress: 17,
                status: "warning",
                itemHash: attemptItemHash,
                detail:
                  "Removing bootstrap configuration for the failed attempt. MetaMask may request a cleanup signature.",
              });
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
                  cleanupAggregateItemHash = cleanupResult.aggregateItemHash;
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

              await this.cleanupStaleVmBootstrapConfigHistory({
                itemHash: attemptItemHash,
                currentAggregateItemHash: cleanupAggregateItemHash,
                stage: "deployment-confirmed",
                progress: 18,
              });
            }
            this.emitProgress({
              stage: "deployment-confirmed",
              label: "Cleaning up failed attempt",
              progress: 18,
              status: "warning",
              itemHash: attemptItemHash,
              detail:
                "Forgetting the failed deployment attempt on Aleph. MetaMask may request another cleanup signature.",
            });
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
              label: "Retrying on next CRN",
              progress: 20,
              status: "warning",
              itemHash: attemptItemHash,
              detail: `${attemptLabel} was discarded: ${lastError.message}`,
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

    const linkedRegistrationHashes = Array.from(
      new Set(
        this.state.bootstrapRegistrations
          .filter((entry) => entry.instanceItemHash === instanceHash)
          .map(
            (entry) =>
              entry.messageHash?.trim() ??
              entry.itemHash?.trim() ??
              entry.hash?.trim() ??
              null,
          )
          .filter((value): value is string => Boolean(value)),
      ),
    );
    const hashesToForget = Array.from(
      new Set([instanceHash, ...linkedRegistrationHashes]),
    );
    const linkedRegistrationCount = linkedRegistrationHashes.length;
    const knownInstance = this.state.instances.find(
      (entry) => entry.instance.item_hash === instanceHash,
    );

    this.patch({
      busy: { deletingInstanceHash: instanceHash },
      errorText: null,
      statusText: `Deleting ${instanceHash}`,
    });

    try {
      this.emitProgress({
        stage: "validating",
        label: "Resolving CRN for delete",
        progress: 6,
        status: "warning",
        itemHash: instanceHash,
        detail:
          linkedRegistrationCount > 0
            ? `Preparing CRN erase and Aleph FORGET for the instance and ${linkedRegistrationCount} linked bootstrap registration${linkedRegistrationCount === 1 ? "" : "s"}.`
            : "Preparing CRN erase and Aleph FORGET.",
      });
      const eraseResult = await eraseInstanceOnCrn({
        sender: this.state.wallet.address,
        signer: personalSign,
        instanceHash,
        fetch: asJsonFetch,
        apiHost: this.client.apiHost,
        crnUrl: knownInstance?.details.crnUrl,
        crnHash:
          knownInstance?.instance.content?.requirements?.node?.node_hash ?? null,
        crnListUrl: this.props.crnListUrl,
        schedulerAllocationUrl: this.client.schedulerApiHost
          ? `${this.client.schedulerApiHost.replace(/\/+$/u, "")}/api/v0/allocation`
          : undefined,
      });
      this.emitProgress({
        stage: "broadcasting-delete",
        label:
          eraseResult.status === "erased"
            ? "Erased VM on CRN"
            : eraseResult.status === "missing"
              ? "VM already absent on CRN"
              : "CRN erase skipped",
        progress: 34,
        status: eraseResult.status === "skipped" ? "warning" : "info",
        itemHash: instanceHash,
        detail:
          eraseResult.status === "erased"
            ? `Erased runtime on ${eraseResult.crnUrl ?? "selected CRN"} before sending FORGET.`
            : eraseResult.status === "missing"
              ? `The CRN no longer reports this VM on ${eraseResult.crnUrl ?? "the selected node"}, so the delete flow can continue with FORGET.`
              : "Could not resolve a CRN endpoint for this instance, so the delete flow is falling back to FORGET-only cleanup.",
      });
      await forgetAlephMessages({
        sender: this.state.wallet.address,
        hashes: hashesToForget,
        reason:
          linkedRegistrationCount > 0
            ? `Deleted instance and ${linkedRegistrationCount} linked relay bootstrap registration${linkedRegistrationCount === 1 ? "" : "s"} from Sponsor Relay panel`
            : "Deleted from Sponsor Relay panel",
        signer: personalSign,
        hasher: sha256Hex,
        fetch: asJsonFetch,
        apiHost: this.client.apiHost,
        onProgress: (event) => {
          this.emitProgress(event);
        },
      });

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
        detail:
          linkedRegistrationCount > 0
            ? "Reloading current deployments and relay bootstrap registrations."
            : "Reloading current deployments.",
      });
      await this.refresh();
      this.trace("delete:submitted", {
        instanceHash,
        linkedRegistrationHashes,
      });
      this.emitProgress({
        stage: "completed",
        label: "Delete completed",
        progress: 100,
        status: "success",
        itemHash: instanceHash,
        detail:
          linkedRegistrationCount > 0
            ? `Delete request submitted, including ${linkedRegistrationCount} linked bootstrap registration${linkedRegistrationCount === 1 ? "" : "s"}, and state refreshed.`
            : "Delete request submitted and deployments refreshed.",
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

  async deleteBootstrapRegistration(registrationHash: string): Promise<void> {
    this.trace("registration-delete:start", { registrationHash });
    if (!this.state.wallet.address) {
      this.patch({
        errorText: "Connect MetaMask before forgetting registrations.",
      });
      return;
    }

    this.patch({
      busy: { deletingRegistrationHash: registrationHash },
      errorText: null,
      statusText: `Forgetting registration ${registrationHash}`,
    });

    try {
      this.emitProgress({
        stage: "validating",
        label: "Validating registration cleanup",
        progress: 6,
        status: "warning",
        itemHash: registrationHash,
        detail:
          "Preparing Aleph FORGET message for the orphan bootstrap registration.",
      });
      await forgetAlephMessages({
        sender: this.state.wallet.address,
        hashes: [registrationHash],
        reason:
          "Deleted orphan relay bootstrap registration from Sponsor Relay panel",
        signer: personalSign,
        hasher: sha256Hex,
        fetch: asJsonFetch,
        apiHost: this.client.apiHost,
        onProgress: (event) => {
          this.emitProgress(event);
        },
      });

      this.patch({
        busy: { deletingRegistrationHash: null },
        statusText: `Deletion submitted for ${registrationHash}`,
      });
      this.emitProgress({
        stage: "refreshing-instances",
        label: "Refreshing registrations after delete",
        progress: 92,
        status: "info",
        itemHash: registrationHash,
        detail: "Reloading deployments and relay bootstrap registrations.",
      });
      await this.refresh();
      this.trace("registration-delete:submitted", { registrationHash });
      this.emitProgress({
        stage: "completed",
        label: "Registration cleanup completed",
        progress: 100,
        status: "success",
        itemHash: registrationHash,
        detail: "Orphan relay bootstrap registration forgotten and state refreshed.",
        error: null,
      });
    } catch (error) {
      this.trace("registration-delete:error", error);
      this.patch({
        busy: { deletingRegistrationHash: null },
        errorText: error instanceof Error ? error.message : String(error),
        statusText: "Registration cleanup failed",
      });
    }
  }
}

export function createSponsorRelayController(
  props: SponsorRelayProps = {},
): SponsorRelayController {
  return new SponsorRelayController(props);
}
