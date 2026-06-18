import { createHash } from "node:crypto";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

import {
  cleanupFailedDeployment,
  configureOrbitdbRelaySetup,
  configureUcGoPeer,
  createRelayBootstrapRegistrationId,
  createInstanceContent,
  deployInstance,
  ensureInstancePortForwards,
  fetchVmRuntime,
  fetchCrns,
  fetchUcGoPeerMetadata,
  notifyCrnAllocationWithRetry,
  publishRelayBootstrapRegistration,
  reconcileOwnerRelayBootstrapRegistrations,
  rankCandidateCrns,
  verifyUcGoPeerReachability,
  waitForRelayBootstrapRegistration,
  waitForDeploymentResult,
  waitForSetupEndpoint,
  waitForVmRuntime,
} from "../../core/src/index.ts";
import { signRelayBootstrapAuthorization } from "../../aleph-bootstrap/src/index.ts";
import type {
  CrnRecord,
  DeploymentInspectionResult,
  MessageHasher,
  MessageSigner,
  RootfsManifest,
} from "@le-space/shared-types";

import type {
  DeployConfigurationResult,
  DeployOutputResult,
} from "./deploy-outputs.ts";
import type { DeployPlan } from "./deploy-plan.ts";
import { deriveBootstrapPublisherPrivateKey } from "./bootstrap-publisher.ts";
import { createPrivateKeyIdentity } from "./signer.ts";
import { deriveLibp2pSecp256k1IdentityFromEvmKey } from "./relay-identity.ts";

export interface DeployExecutorDependencies {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  tcpProbe?: (
    host: string,
    port: number,
    timeoutMs?: number,
  ) => Promise<{ ok: boolean | null; error?: string }>;
  signer?: MessageSigner;
  sender?: string;
  hasher?: MessageHasher;
  manifest?: RootfsManifest | null;
  log?: (message: string) => void;
}

type AlephBalanceSnapshot = {
  balance?: unknown;
  credit_balance?: unknown;
  locked_amount?: unknown;
};

function defaultHasher(payload: string): string {
  return createHash("sha256").update(payload).digest("hex");
}

async function defaultTcpProbe(
  host: string,
  port: number,
  timeoutMs = 5000,
): Promise<{ ok: boolean; error?: string }> {
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host, port: Number(port) });
    const finalize = (result: { ok: boolean; error?: string }) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finalize({ ok: true }));
    socket.once("timeout", () =>
      finalize({ ok: false, error: `timeout after ${timeoutMs}ms` }),
    );
    socket.once("error", (error) =>
      finalize({ ok: false, error: error.message }),
    );
  });
}

function diagnosticsFromInspection(
  result: DeploymentInspectionResult,
  plan: DeployPlan,
) {
  if (result.status === "processed") {
    return {
      state: "aleph-processed",
      timedOut: false,
      reason: "Deployment message processed by Aleph.",
    };
  }

  if (result.status === "rejected") {
    return {
      state: "aleph-rejected",
      timedOut: false,
      reason: result.rejectionReason ?? "Aleph rejected the deployment.",
    };
  }

  return {
    state: "aleph-processing-timeout",
    timedOut: true,
    reason: `Deployment remained ${result.status} after ${plan.waitAttempts} poll attempt(s).`,
  };
}

function mergeVerificationState(args: {
  inspection: DeploymentInspectionResult;
  runtime?: DeployOutputResult["runtime"];
}) {
  const runtimeState = args.runtime?.diagnostics?.state ?? null;
  return {
    ok: args.inspection.status === "processed",
    state: runtimeState ?? args.inspection.status,
    rejectionReason: args.inspection.rejectionReason,
    references: args.inspection.references,
  };
}

function describeBalanceSnapshot(snapshot: AlephBalanceSnapshot): string {
  return [
    `balance=${snapshot.balance ?? "-"}`,
    `credit_balance=${snapshot.credit_balance ?? "-"}`,
    `locked_amount=${snapshot.locked_amount ?? "-"}`,
  ].join(" ");
}

async function logBalancePreflight(args: {
  address: string;
  apiHost: string;
  fetch: typeof fetch;
  log: (message: string) => void;
}): Promise<void> {
  try {
    const response = await args.fetch(
      `${args.apiHost}/api/v0/addresses/${args.address}/balance`,
      { cache: "no-cache" },
    );
    if (!response.ok) {
      args.log(
        `[deploy] balance preflight lookup failed: status=${response.status}`,
      );
      return;
    }

    const snapshot = (await response.json()) as AlephBalanceSnapshot;
    args.log(
      `[deploy] preflight balance for ${args.address}: ${describeBalanceSnapshot(
        snapshot,
      )}`,
    );
  } catch (error) {
    args.log(
      `[deploy] balance preflight lookup failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function candidateCrnsForPlan(
  plan: DeployPlan,
  fetchImpl: typeof fetch,
): Promise<CrnRecord[]> {
  const crns = await fetchCrns({
    url: plan.crnListUrl,
    fetch: fetchImpl,
  });

  if (plan.crnHash) {
    const explicit = crns.find((crn) => crn.hash === plan.crnHash);
    return explicit ? [explicit] : [];
  }

  return (
    await rankCandidateCrns(crns, {
      fetch: fetchImpl,
      preferredCountryCode: plan.preferredCountryCode,
      geoLimit: plan.geoCrnLimit,
    })
  ).slice(0, Math.max(1, plan.maxCrnAttempts));
}

function buildManifest(
  plan: DeployPlan,
  manifest: RootfsManifest | null | undefined,
): RootfsManifest {
  return (
    manifest ?? {
      version: "1.0",
      profile: plan.profile,
      rootfsItemHash: plan.rootfsItemHash,
      rootfsSizeMiB: plan.rootfsSizeMiB,
      rootfsInstallStrategy: "thin",
      requiredPortForwards: plan.requiredPorts,
      createdAt: new Date().toISOString(),
      notes: "Synthetic manifest assembled by the shared deploy executor.",
    }
  );
}

export async function executeDeployPlan(
  plan: DeployPlan,
  dependencies: DeployExecutorDependencies = {},
): Promise<DeployOutputResult> {
  const fetchImpl = dependencies.fetch ?? globalThis.fetch?.bind(globalThis);
  if (typeof fetchImpl !== "function") {
    throw new Error(
      "A fetch implementation is required to execute the shared deploy plan.",
    );
  }

  const hasher = dependencies.hasher ?? defaultHasher;
  const tcpProbe = dependencies.tcpProbe ?? defaultTcpProbe;
  const sleepImpl =
    dependencies.sleep ?? ((ms) => sleep(ms).then(() => undefined));
  const log = dependencies.log ?? ((message: string) => console.log(message));
  const resolvedBootstrapPublisherPrivateKey =
    plan.bootstrapPublisherPrivateKey ||
    deriveBootstrapPublisherPrivateKey({
      sourcePrivateKey: plan.privateKey,
      profile: plan.profile,
    });
  const identity =
    dependencies.sender && dependencies.signer
      ? { address: dependencies.sender, signer: dependencies.signer }
      : await createPrivateKeyIdentity(plan.privateKey);
  const bootstrapPublisherIdentity = await createPrivateKeyIdentity(
    resolvedBootstrapPublisherPrivateKey,
  );
  const bootstrapOwnerIdentity = plan.bootstrapOwnerPrivateKey
    ? await createPrivateKeyIdentity(plan.bootstrapOwnerPrivateKey)
    : null;
  const isOrbitdbRelayProfile = plan.profile === "orbitdb-relay";
  const publisherDerivedRelayIdentity =
    (plan.profile === "uc-go-peer" || isOrbitdbRelayProfile) &&
    resolvedBootstrapPublisherPrivateKey
      ? deriveLibp2pSecp256k1IdentityFromEvmKey(
          resolvedBootstrapPublisherPrivateKey,
        )
      : null;

  const candidateCrns = await candidateCrnsForPlan(plan, fetchImpl);
  if (candidateCrns.length === 0) {
    throw new Error("No compatible CRN was available for deployment.");
  }

  log(`[deploy] profile=${plan.profile} sender=${identity.address}`);
  log(`[deploy] channel=${plan.channel} api_host=${plan.apiHost}`);
  await logBalancePreflight({
    address: identity.address,
    apiHost: plan.apiHost,
    fetch: fetchImpl,
    log,
  });
  log(
    `[deploy] candidate CRNs=${candidateCrns
      .map((crn) => `${crn.name ?? crn.hash}:${crn.hash}`)
      .join(", ")}`,
  );

  let lastError: Error | null = null;

  for (const [candidateIndex, candidateCrn] of candidateCrns.entries()) {
    log(
      `[deploy] attempting CRN ${candidateIndex + 1}/${candidateCrns.length}: ${candidateCrn.name ?? candidateCrn.hash} (${candidateCrn.hash})`,
    );
    const content = createInstanceContent({
      address: identity.address,
      name: plan.name,
      sshPublicKey: plan.sshPublicKey,
      rootfsItemHash: plan.rootfsItemHash,
      rootfsSizeMiB: plan.rootfsSizeMiB,
      vcpus: plan.vcpus,
      memoryMiB: plan.memoryMiB,
      seconds: plan.seconds,
      rootfsVersion: plan.rootfsVersion || "custom-rootfs",
      crnHash: candidateCrn.hash,
      deployer: "relay-button",
    });

    const deployment = await deployInstance({
      sender: identity.address,
      content,
      hasher,
      signer: identity.signer,
      fetch: fetchImpl,
      apiHost: plan.apiHost,
      channel: plan.channel,
      sync: true,
    });

    log(
      `[deploy] broadcasted INSTANCE message ${deployment.itemHash} on ${candidateCrn.name ?? candidateCrn.hash}`,
    );

    const inspection = await waitForDeploymentResult(deployment.itemHash, {
      rootfsRef: plan.rootfsItemHash,
      apiHost: plan.apiHost,
      fetch: fetchImpl,
      attempts: plan.waitAttempts,
      delayMs: plan.waitDelayMs,
      sleep: sleepImpl,
      onAttempt: (result, attempt, attempts) => {
        log(
          `[deploy] Aleph processing ${attempt}/${attempts} for ${deployment.itemHash}: status=${result.status}${
            result.rejectionReason ? ` reason=${result.rejectionReason}` : ""
          }`,
        );
      },
    });

    if (inspection.status === "rejected") {
      if (inspection.details) {
        log(
          `[deploy] raw rejection details for ${deployment.itemHash}: ${JSON.stringify(
            inspection.details,
          )}`,
        );
      }
      log(
        `[deploy] CRN ${candidateCrn.name ?? candidateCrn.hash} rejected deployment ${deployment.itemHash}: ${
          inspection.rejectionReason ?? "no additional reason"
        }`,
      );
      lastError = new Error(
        `Deployment on ${candidateCrn.name ?? candidateCrn.hash} was rejected: ${inspection.rejectionReason ?? "no additional rejection reason from Aleph"}.`,
      );
      continue;
    }

    if (inspection.status !== "processed") {
      log(
        `[deploy] deployment ${deployment.itemHash} on ${candidateCrn.name ?? candidateCrn.hash} did not become processed; cleaning up`,
      );
      await cleanupFailedDeployment({
        sender: identity.address,
        instanceItemHash: deployment.itemHash,
        reason: `Deployment message stayed ${inspection.status}`,
        signer: identity.signer,
        hasher,
        fetch: fetchImpl,
        channel: plan.channel,
        apiHost: plan.apiHost,
      });
      lastError = new Error(
        `Deployment message ${deployment.itemHash} on ${candidateCrn.name ?? candidateCrn.hash} stayed ${inspection.status} without becoming processed.`,
      );
      continue;
    }

    let portForwarding: DeployOutputResult["portForwarding"] = null;
    if (plan.publishPortForwards && plan.requiredPorts.length > 0) {
      log(
        `[deploy] publishing required port-forward aggregate for ${deployment.itemHash}`,
      );
      const aggregate = await ensureInstancePortForwards({
        sender: identity.address,
        instanceItemHash: deployment.itemHash,
        manifest: buildManifest(plan, dependencies.manifest),
        signer: identity.signer,
        hasher,
        fetch: fetchImpl,
        channel: plan.channel,
        apiHost: plan.apiHost,
        sync: true,
      });

      portForwarding = {
        aggregateItemHash: aggregate.aggregateItemHash,
        aggregateStatus: aggregate.aggregateStatus,
      };
      log(
        `[deploy] port-forward aggregate published: item_hash=${aggregate.aggregateItemHash} status=${aggregate.aggregateStatus}`,
      );
    }

    if (candidateCrn.address) {
      log(`[deploy] notifying CRN allocation endpoint ${candidateCrn.address}`);
      await notifyCrnAllocationWithRetry({
        crnUrl: candidateCrn.address,
        itemHash: deployment.itemHash,
        fetch: fetchImpl,
      }).catch(() => null);
    }

    log(
      `[deploy] waiting for runtime networking on ${candidateCrn.name ?? candidateCrn.hash}`,
    );
    let runtime = await waitForVmRuntime({
      itemHash: deployment.itemHash,
      fetch: fetchImpl,
      crnHash: candidateCrn.hash,
      crns: candidateCrns,
      crnListUrl: plan.crnListUrl,
      requirePublicGuestIpv6ForProxy: plan.enableCaddyProxy === true,
      attempts: plan.runtimeAttempts,
      delayMs: plan.runtimeDelayMs,
      sleep: sleepImpl,
      onAttempt: (runtimeAttempt, attempt, attempts) => {
        log(
          `[deploy] runtime ${attempt}/${attempts} for ${deployment.itemHash}: state=${
            runtimeAttempt.diagnostics?.state ?? "unknown"
          } host=${runtimeAttempt.hostIpv4 ?? "-"} mapped_ports=${
            Object.keys(runtimeAttempt.mappedPorts ?? {}).length
          }`,
        );
      },
    }).catch(() => null);

    const runtimeMetadata: NonNullable<DeployOutputResult["runtime"]> = runtime
      ? {
          allocation: runtime.allocation,
          hostIpv4: runtime.hostIpv4,
          ipv6: runtime.ipv6,
          proxyUrl: runtime.proxyUrl,
          sshCommand: runtime.sshCommand,
          setupHealth: null,
          mappedPorts: runtime.mappedPorts,
          diagnostics: runtime.diagnostics,
          selectedCrn: runtime.selectedCrn ?? {
            hash: candidateCrn.hash,
            name: candidateCrn.name ?? "",
          },
        }
      : {
          allocation: null,
          hostIpv4: null,
          ipv6: null,
          proxyUrl: null,
          sshCommand: null,
          setupHealth: null,
          mappedPorts: {},
          diagnostics: diagnosticsFromInspection(inspection, plan),
          selectedCrn: {
            hash: candidateCrn.hash,
            name: candidateCrn.name ?? "",
          },
        };

    if (runtime?.diagnostics?.state !== "ready") {
      log(
        `[deploy] processed deployment ${deployment.itemHash} never exposed usable runtime networking on ${
          candidateCrn.name ?? candidateCrn.hash
        }; cleaning up`,
      );
      await cleanupFailedDeployment({
        sender: identity.address,
        instanceItemHash: deployment.itemHash,
        reason: `Processed deployment never exposed runtime networking${runtime?.diagnostics?.state ? ` (${runtime.diagnostics.state})` : ""}`,
        signer: identity.signer,
        hasher,
        fetch: fetchImpl,
        channel: plan.channel,
        apiHost: plan.apiHost,
      });
      lastError = new Error(
        `Deployment ${deployment.itemHash} on ${candidateCrn.name ?? candidateCrn.hash} was processed but did not expose runtime networking in time.${runtime?.diagnostics?.reason ? ` ${runtime.diagnostics.reason}` : ""}`,
      );
      continue;
    }

    let configuration: DeployOutputResult["configuration"] = null;
    let verification: DeployOutputResult["verification"] = null;

    if (
      runtime.hostIpv4 &&
      plan.autoConfigure !== false &&
      (plan.profile === "uc-go-peer" || isOrbitdbRelayProfile)
    ) {
        const mappedPorts = runtime.mappedPorts ?? {};
      const setupPort = mappedPorts["80"]?.host ?? null;
      let proxyUrl = plan.enableCaddyProxy ? (runtime.proxyUrl ?? null) : null;

      if (
        plan.enableCaddyProxy &&
        proxyUrl &&
        runtime.webAccess?.active !== true
      ) {
        log(
          `[deploy] proxy URL reserved but not active yet for ${deployment.itemHash}; waiting before guest configure`,
        );
        let latestRuntime = runtime;
        for (let attempt = 0; attempt < plan.setupAttempts; attempt += 1) {
          if (latestRuntime.webAccess?.active === true) {
            break;
          }
          await sleepImpl(plan.setupDelayMs);
          latestRuntime = await fetchVmRuntime({
            itemHash: deployment.itemHash,
            fetch: fetchImpl,
            crnHash: candidateCrn.hash,
            crns: candidateCrns,
            crnListUrl: plan.crnListUrl,
          }).catch(() => latestRuntime);
          log(
            `[deploy] proxy activation ${attempt + 1}/${plan.setupAttempts}: active=${
              latestRuntime.webAccess?.active === true
            } proxy=${latestRuntime.proxyUrl ?? "-"}`,
          );
        }
        runtime = latestRuntime;
        runtimeMetadata.allocation = runtime.allocation;
        runtimeMetadata.hostIpv4 = runtime.hostIpv4;
        runtimeMetadata.ipv6 = runtime.ipv6;
        runtimeMetadata.proxyUrl = runtime.proxyUrl;
        runtimeMetadata.sshCommand = runtime.sshCommand;
        runtimeMetadata.mappedPorts = runtime.mappedPorts;
        runtimeMetadata.diagnostics = runtime.diagnostics;
        runtimeMetadata.selectedCrn = runtime.selectedCrn ?? {
          hash: candidateCrn.hash,
          name: candidateCrn.name ?? "",
        };
        proxyUrl = runtime.webAccess?.active === true ? (runtime.proxyUrl ?? null) : null;
        if (!proxyUrl) {
          log(
            `[deploy] proxy URL still inactive for ${deployment.itemHash}; configuring relay without Caddy for now`,
          );
        }
      }

      if (setupPort && runtime.hostIpv4) {
        log(
          `[deploy] waiting for temporary setup endpoint on http://${runtime.hostIpv4}:${setupPort}/health`,
        );
        const setupHealth = await waitForSetupEndpoint({
          hostIpv4: runtime.hostIpv4,
          setupPort,
          fetch: fetchImpl,
          attempts: plan.setupAttempts,
          delayMs: plan.setupDelayMs,
          httpTimeoutMs: plan.httpTimeoutMs,
          sleep: sleepImpl,
          onAttempt: (result, attempt, attempts) => {
            log(
              `[deploy] setup endpoint ${attempt}/${attempts}: ok=${result.ok} status=${
                result.status ?? "-"
              } error=${result.error ?? "-"}`,
            );
          },
        });

        runtimeMetadata.setupHealth = setupHealth;
        if (!setupHealth.ok) {
          log(
            `[deploy] setup endpoint never became reachable; cleaning up ${deployment.itemHash}`,
          );
          await cleanupFailedDeployment({
            sender: identity.address,
            instanceItemHash: deployment.itemHash,
            reason: "Temporary setup endpoint never became reachable",
            signer: identity.signer,
            hasher,
            fetch: fetchImpl,
            channel: plan.channel,
            apiHost: plan.apiHost,
          });
          lastError = new Error(
            `Temporary setup endpoint did not become reachable at http://${runtime.hostIpv4}:${setupPort}/health.`,
          );
          continue;
        }

        if (isOrbitdbRelayProfile) {
          const orbitdbTcpPort = mappedPorts["9091"]?.host ?? null;
          const orbitdbWsPort =
            mappedPorts["9092"]?.host ?? mappedPorts["443"]?.host ?? null;
          if (!orbitdbTcpPort || !orbitdbWsPort) {
            log(
              `[deploy] orbitdb relay runtime is missing required mapped ports; cleaning up ${deployment.itemHash}`,
            );
            await cleanupFailedDeployment({
              sender: identity.address,
              instanceItemHash: deployment.itemHash,
              reason: "OrbitDB relay runtime missing mapped TCP/WS ports",
              signer: identity.signer,
              hasher,
              fetch: fetchImpl,
              channel: plan.channel,
              apiHost: plan.apiHost,
            });
            lastError = new Error(
              "OrbitDB relay runtime did not expose the required mapped TCP/WS ports in time.",
            );
            continue;
          }
        }

        log(`[deploy] calling guest /configure for ${deployment.itemHash}`);
        const registrationId = createRelayBootstrapRegistrationId(
          plan.profile,
          plan.name,
          deployment.itemHash,
        );
        const publisherAddress =
          bootstrapPublisherIdentity?.address ?? identity.address;
        const precomputedOwnerAuthorization =
          bootstrapOwnerIdentity != null &&
          publisherDerivedRelayIdentity != null &&
          (plan.profile === "uc-go-peer" || isOrbitdbRelayProfile)
            ? await signRelayBootstrapAuthorization({
                ownerAddress: bootstrapOwnerIdentity.address,
                publisherAddress,
                peerId: publisherDerivedRelayIdentity.peerId,
                registrationId,
                profile: plan.profile,
                version: plan.rootfsVersion || "custom-rootfs",
                issuedAt: Date.now(),
                signer: bootstrapOwnerIdentity.signer,
              })
            : undefined;
        const configureResult =
          isOrbitdbRelayProfile
            ? await configureOrbitdbRelaySetup({
                hostIpv4: runtime.hostIpv4,
                publicIpv6: runtime.ipv6,
                setupPort,
                tcpPort: mappedPorts["9091"]?.host ?? 0,
                wsPort:
                  mappedPorts["9092"]?.host ?? mappedPorts["443"]?.host ?? 0,
                proxyUrl,
                metricsPort: mappedPorts["9090"]?.host ?? null,
                metricsHttpsPort: mappedPorts["443"]?.host ?? null,
                webrtcPort: mappedPorts["9093"]?.host ?? null,
                quicPort: mappedPorts["9094"]?.host ?? null,
                bootstrapPublisherPrivateKey:
                  resolvedBootstrapPublisherPrivateKey || null,
                bootstrapPublisherLibp2pIdentityHex:
                  publisherDerivedRelayIdentity?.protobuf
                    ? Buffer.from(
                        publisherDerivedRelayIdentity.protobuf,
                      ).toString("hex")
                    : null,
                bootstrapOwnerAuthorizationBase64: precomputedOwnerAuthorization
                  ? Buffer.from(
                      JSON.stringify(precomputedOwnerAuthorization),
                      "utf8",
                    ).toString("base64")
                  : null,
                bootstrapRegistrationId: `relay:${plan.profile}:${plan.name}`,
                fetch: fetchImpl,
                timeoutMs: plan.configureTimeoutMs,
              })
            : await configureUcGoPeer({
                hostIpv4: runtime.hostIpv4,
                publicIpv6: runtime.ipv6,
                setupPort,
                tcpPort: mappedPorts["9095"]?.host ?? null,
                wsPort:
                  mappedPorts["9097"]?.host ??
                  mappedPorts["9095"]?.host ??
                  null,
                udpPort:
                  mappedPorts["9095"]?.udp === true
                    ? (mappedPorts["9095"]?.host ?? null)
                    : null,
                quicPort:
                  mappedPorts["9095"]?.udp === true
                    ? (mappedPorts["9095"]?.host ?? null)
                    : null,
                webrtcPort:
                  mappedPorts["9095"]?.udp === true
                    ? (mappedPorts["9095"]?.host ?? null)
                    : null,
                proxyUrl,
                bootstrapPublisherPrivateKey:
                  resolvedBootstrapPublisherPrivateKey || null,
                bootstrapPublisherLibp2pIdentityBase64:
                  publisherDerivedRelayIdentity?.protobufBase64 ?? null,
                bootstrapOwnerAuthorizationBase64: precomputedOwnerAuthorization
                  ? Buffer.from(
                      JSON.stringify(precomputedOwnerAuthorization),
                      "utf8",
                    ).toString("base64")
                  : null,
                bootstrapRegistrationId: registrationId,
                fetch: fetchImpl,
                timeoutMs: plan.configureTimeoutMs,
              });

        log(`[deploy] polling guest /metadata until ready`);
        const metadataResult = await fetchUcGoPeerMetadata({
          hostIpv4: runtime.hostIpv4,
          setupPort,
          fetch: fetchImpl,
          attempts: plan.metadataAttempts,
          delayMs: plan.metadataDelayMs,
          timeoutMs: plan.metadataTimeoutMs,
          sleep: sleepImpl,
          isReady: ({ payload, ok }) => {
            if (!ok || !payload || typeof payload !== "object") return false;
            const metadata =
              (payload as { metadata?: unknown }).metadata &&
              typeof (payload as { metadata?: unknown }).metadata === "object"
                ? ((payload as { metadata: Record<string, unknown> }).metadata)
                : null;
            return Boolean(
              typeof metadata?.peer_id === "string" &&
                Array.isArray(metadata?.probe_multiaddrs) &&
                metadata.probe_multiaddrs.some(
                  (entry) => typeof entry === "string" && entry.length > 0,
                ),
            );
          },
          onAttempt: ({ ready, attempt, attempts, status, requestUrl, error }) => {
            log(
              `[deploy] guest metadata ${attempt}/${attempts}: ready=${ready} status=${status ?? "-"} url=${requestUrl}${error ? ` error=${error}` : ""}`,
            );
          },
        });

        configuration = {
          ...(configureResult && typeof configureResult === "object"
            ? (configureResult as Record<string, unknown>)
            : {}),
          metadata:
            metadataResult && typeof metadataResult === "object"
              ? (((metadataResult as { metadata?: unknown }).metadata ??
                  null) as DeployConfigurationResult["metadata"])
              : null,
        };

        if (plan.verifyReachability !== false) {
          let latestVerification: DeployOutputResult["verification"] = null;
          for (let attempt = 0; attempt < plan.verifyAttempts; attempt += 1) {
            log(
              `[deploy] reachability verification ${attempt + 1}/${plan.verifyAttempts}`,
            );
            latestVerification = await verifyUcGoPeerReachability({
              hostIpv4: runtime.hostIpv4,
              mappedPorts,
              proxyUrl,
              verifyProxyHttp: !plan.enableCaddyProxy,
              skipInternalPorts: plan.enableCaddyProxy ? ["80"] : ["80", "443"],
              tcpTimeoutMs: plan.tcpTimeoutMs,
              httpTimeoutMs: plan.httpTimeoutMs,
              fetch: fetchImpl,
              tcpProbe,
            });
            if (latestVerification?.ok) {
              log(`[deploy] reachability verification succeeded`);
              break;
            }
            if (attempt < plan.verifyAttempts - 1) {
              log(
                `[deploy] reachability verification not ready yet; sleeping ${plan.verifyDelayMs}ms`,
              );
              await sleepImpl(plan.verifyDelayMs);
            }
          }
          verification = latestVerification;
        }

        const metadata = configuration?.metadata ?? null;
        if (
          publisherDerivedRelayIdentity &&
          metadata?.peer_id &&
          metadata.peer_id !== publisherDerivedRelayIdentity.peerId
        ) {
          log(
            `[deploy] guest peerId ${metadata.peer_id} did not match preseeded publisher-derived peerId ${publisherDerivedRelayIdentity.peerId}; cleaning up`,
          );
          await cleanupFailedDeployment({
            sender: identity.address,
            instanceItemHash: deployment.itemHash,
            reason: "Relay peerId did not match the publisher-derived libp2p identity",
            signer: identity.signer,
            hasher,
            fetch: fetchImpl,
            channel: plan.channel,
            apiHost: plan.apiHost,
          });
          lastError = new Error(
            `Relay peerId ${metadata.peer_id} did not match the publisher-derived libp2p identity ${publisherDerivedRelayIdentity.peerId}.`,
          );
          continue;
        }
        if (
          metadata?.peer_id &&
          Array.isArray(metadata.probe_multiaddrs) &&
          metadata.probe_multiaddrs.length > 0 &&
          (plan.verifyReachability === false || verification?.ok !== false)
        ) {
          try {
            log(`[deploy] publishing relay bootstrap registration to Aleph`);
            const ownerAuthorization =
              precomputedOwnerAuthorization ??
              (bootstrapOwnerIdentity != null
                ? await signRelayBootstrapAuthorization({
                    ownerAddress: bootstrapOwnerIdentity.address,
                    publisherAddress,
                    peerId: metadata.peer_id,
                    registrationId,
                    profile: plan.profile,
                    version: plan.rootfsVersion || "custom-rootfs",
                    issuedAt: Date.now(),
                    signer: bootstrapOwnerIdentity.signer,
                  })
                : undefined);
            const publication = await publishRelayBootstrapRegistration({
              sender: publisherAddress,
              signer: bootstrapPublisherIdentity?.signer ?? identity.signer,
              hasher,
              fetch: fetchImpl,
              apiHost: plan.apiHost,
              peerId: metadata.peer_id,
              multiaddrs: metadata.probe_multiaddrs,
              browserMultiaddrs: metadata.browser_bootstrap_multiaddrs,
              ownerAddress: bootstrapOwnerIdentity?.address,
              publisherAddress,
              ownerAuthorization,
              publisherSigner:
                bootstrapPublisherIdentity?.signer ?? undefined,
              registrationId,
              forgetPrevious: true,
              profile: plan.profile,
              version: plan.rootfsVersion || "custom-rootfs",
              sync: true,
            });
            const visibleRegistration = await waitForRelayBootstrapRegistration({
              sender: publisherAddress,
              registrationId,
              peerId: metadata.peer_id,
              fetch: fetchImpl,
              apiHost: plan.apiHost,
              channel: plan.channel,
              attempts: 12,
              delayMs: 2500,
            });
            if (!visibleRegistration) {
              throw new Error(
                "Relay bootstrap registration did not become visible on Aleph.",
              );
            }
            const reconcileResult =
              await reconcileOwnerRelayBootstrapRegistrations({
                instanceOwnerAddress: identity.address,
                sender: publisherAddress,
                signer: bootstrapPublisherIdentity?.signer ?? identity.signer,
                hasher,
                fetch: fetchImpl,
                apiHost: plan.apiHost,
                channel: plan.channel,
                profile: plan.profile,
                ownerAddress: bootstrapOwnerIdentity?.address,
                ownerSigner: bootstrapOwnerIdentity?.signer,
                publisherAddress,
                publisherSigner:
                  bootstrapPublisherIdentity?.signer ?? undefined,
                crns: candidateCrns,
                crnListUrl: plan.crnListUrl,
                current: {
                  itemHash: deployment.itemHash,
                  registrationId,
                  peerId: metadata.peer_id,
                  probeMultiaddrs: metadata.probe_multiaddrs,
                  browserBootstrapMultiaddrs:
                    metadata.browser_bootstrap_multiaddrs,
                },
              });
            if (reconcileResult.errors.length > 0) {
              log(
                `[deploy] owner relay bootstrap reconcile completed with ${reconcileResult.errors.length} warning(s): ${JSON.stringify(
                  reconcileResult.errors,
                )}`,
              );
            }
            if (
              ownerAuthorization &&
              runtime.hostIpv4 &&
              isOrbitdbRelayProfile &&
              !publisherDerivedRelayIdentity
            ) {
              const ownerAuthorizationBase64 = Buffer.from(
                JSON.stringify(ownerAuthorization),
                "utf8",
              ).toString("base64");

              log(`[deploy] persisting relay bootstrap authorization in guest`);
              await configureOrbitdbRelaySetup({
                hostIpv4: runtime.hostIpv4,
                publicIpv6: runtime.ipv6,
                setupPort,
                tcpPort: mappedPorts["9091"]?.host ?? 0,
                wsPort:
                  mappedPorts["9092"]?.host ?? mappedPorts["443"]?.host ?? 0,
                proxyUrl,
                metricsPort: mappedPorts["9090"]?.host ?? null,
                metricsHttpsPort: mappedPorts["443"]?.host ?? null,
                webrtcPort: mappedPorts["9093"]?.host ?? null,
                quicPort: mappedPorts["9094"]?.host ?? null,
                bootstrapPublisherPrivateKey:
                  resolvedBootstrapPublisherPrivateKey || null,
                bootstrapOwnerAuthorizationBase64: ownerAuthorizationBase64,
                bootstrapRegistrationId: registrationId,
                noStart: true,
                fetch: fetchImpl,
                timeoutMs: plan.configureTimeoutMs,
              });
            }
            configuration = {
              ...(configuration ?? {}),
              metadata: {
                ...(configuration?.metadata ?? {}),
                bootstrap_registration: publication,
              },
            };
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            log(`[deploy] relay bootstrap registration failed: ${reason}`);
            configuration = {
              ...(configuration ?? {}),
              metadata: {
                ...(configuration?.metadata ?? {}),
                bootstrap_registration: {
                  status: "error",
                  reason,
                },
              },
            };
          }
        }
      }
    }

    verification =
      verification ??
      mergeVerificationState({
        inspection,
        runtime: runtimeMetadata,
      });

    return {
      sender: identity.address,
      itemHash: deployment.itemHash,
      httpStatus: deployment.httpStatus,
      status: inspection.status,
      selectedCrn: { hash: candidateCrn.hash, name: candidateCrn.name ?? "" },
      portForwarding,
      runtime: runtimeMetadata,
      configuration,
      verification,
    };
  }

  log(`[deploy] no candidate CRN succeeded`);
  throw (
    lastError ?? new Error("No compatible CRN deployment attempt succeeded.")
  );
}
