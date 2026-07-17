import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import type { PortMapping } from "@le-space/shared-types";
import {
  createRelayBootstrapRegistrationId,
  listGeocodedCrns,
  publishRelayBootstrapRegistration,
  reconcileOwnerRelayBootstrapRegistrations,
  retainSuccessfulDeployments,
} from "../../core/src/index.ts";

import { integerEnv, jsonEnv, optionalEnv, requiredEnv } from "./env.ts";
import { normalizeAlephApiHost } from "./aleph-api-hosts.ts";
import {
  emitDeployOutputs,
  emitGeocodedCrnOutputs,
  type DeployOutputResult,
} from "./deploy-outputs.ts";
import {
  appendGithubOutput,
  appendGithubSummary,
  actionLog,
} from "./github-outputs.ts";
import { executeDeployPlan } from "./deploy-executor.ts";
import { parseDeployPlan, resolveDeployPlanRootfs } from "./deploy-plan.ts";
import type { DeployPlan } from "./deploy-plan.ts";
import { createPrivateKeyIdentity, type PrivateKeyIdentity } from "./signer.ts";
import {
  deriveUcanStoreBootstrapPackageFromEnv,
  shouldDeriveUcanStoreBootstrapPackage,
} from "./ucan-store-bootstrap.ts";

function parseOptionalJson<T>(raw: string | undefined): T | null {
  if (!raw || !raw.trim()) return null;
  return JSON.parse(raw) as T;
}

function defaultHasher(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function uniqueNonEmptyValues(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    const value = normalizeAlephApiHost(raw);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function parseApiHostCandidates(
  fallbackApiHost: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const rawHosts = optionalEnv("ALEPH_VM_API_HOSTS", "", env).trim();
  if (!rawHosts) {
    return [normalizeAlephApiHost(fallbackApiHost)];
  }

  const explicitHosts = rawHosts.split(/[\s,]+/u);
  const hosts = uniqueNonEmptyValues(explicitHosts);
  if (hosts.length === 0) {
    throw new Error("ALEPH_VM_API_HOSTS did not contain any API host URLs.");
  }
  return hosts;
}

async function withApiHostFallback<T>(args: {
  label: string;
  fallbackApiHost: string;
  env: NodeJS.ProcessEnv;
  run: (apiHost: string) => Promise<T>;
}): Promise<{ result: T; apiHost: string }> {
  const apiHosts = parseApiHostCandidates(args.fallbackApiHost, args.env);
  let lastError: unknown = null;

  for (const [index, apiHost] of apiHosts.entries()) {
    try {
      if (apiHosts.length > 1) {
        actionLog(
          "notice",
          `Aleph ${args.label} API host attempt ${index + 1}/${apiHosts.length}: ${apiHost}`,
        );
      }
      return { result: await args.run(apiHost), apiHost };
    } catch (error) {
      lastError = error;
      if (index < apiHosts.length - 1) {
        const message = error instanceof Error ? error.message : String(error);
        actionLog(
          "warning",
          `Aleph ${args.label} API host ${apiHost} failed; retrying with ${apiHosts[index + 1]}. ${message}`,
        );
      }
    }
  }

  const suffix =
    lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `Aleph ${args.label} failed through all configured API hosts (${apiHosts.join(", ")}). Last error: ${suffix}`,
  );
}

async function executeDeployPlanWithApiHostFallback(args: {
  plan: DeployPlan;
  env: NodeJS.ProcessEnv;
  deployExecutor: typeof executeDeployPlan;
}): Promise<DeployOutputResult> {
  const apiHosts = parseApiHostCandidates(args.plan.apiHost, args.env);
  const apiHost = apiHosts[0] ?? normalizeAlephApiHost(args.plan.apiHost);
  if (apiHosts.length > 1) {
    actionLog(
      "notice",
      `Aleph deploy API host attempt 1/${apiHosts.length}: ${apiHost}`,
    );
  }

  try {
    return await args.deployExecutor({
      ...args.plan,
      apiHost,
    });
  } catch (error) {
    if (apiHosts.length > 1) {
      const skippedHosts = apiHosts.slice(1).join(", ");
      const message = error instanceof Error ? error.message : String(error);
      actionLog(
        "warning",
        `Aleph deploy API host ${apiHost} failed; not retrying deploy on ${skippedHosts} because deploy mode may already have created an INSTANCE. ${message}`,
      );
    }
    throw error;
  }
}

export function buildScaffoldDeployResult(
  env: NodeJS.ProcessEnv = process.env,
): DeployOutputResult {
  const profile = optionalEnv("ALEPH_VM_PROFILE", "uc-go-peer", env);
  const itemHash = optionalEnv("ALEPH_VM_INSTANCE_ITEM_HASH", "", env);
  const status = optionalEnv(
    "ALEPH_VM_INSTANCE_STATUS",
    itemHash ? "processed" : "unknown",
    env,
  );

  return {
    sender: optionalEnv("ALEPH_VM_DEPLOYER_ADDRESS", "", env),
    itemHash,
    status,
    portForwarding: {
      aggregateItemHash: optionalEnv(
        "ALEPH_VM_PORT_FORWARD_AGGREGATE_ITEM_HASH",
        "",
        env,
      ),
      aggregateStatus: optionalEnv("ALEPH_VM_PORT_FORWARD_STATUS", "", env),
    },
    runtime: {
      allocation: {
        source: "manual",
        crnUrl: optionalEnv("ALEPH_VM_CRN_URL", "", env),
      },
      hostIpv4: optionalEnv("ALEPH_VM_HOST_IPV4", "", env),
      ipv6: optionalEnv("ALEPH_VM_IPV6", "", env),
      proxyUrl: optionalEnv("ALEPH_VM_WEB_PROXY_URL", "", env),
      sshCommand: optionalEnv("ALEPH_VM_SSH_COMMAND", "", env),
      setupHealth: {
        ok: optionalEnv("ALEPH_VM_SETUP_ENDPOINT_OK", "", env) === "true",
      },
      mappedPorts:
        parseOptionalJson<Record<string, PortMapping>>(
          env.ALEPH_VM_MAPPED_PORTS_JSON,
        ) ?? {},
      diagnostics: {
        state: "scaffold",
        timedOut: false,
        reason: `Shared action runner scaffold for profile ${profile}`,
      },
      selectedCrn: {
        hash: optionalEnv("ALEPH_VM_CRN_HASH", "", env),
        name: optionalEnv("ALEPH_VM_CRN_NAME", "", env),
      },
    },
    configuration: {
      metadata: {
        peer_id: optionalEnv("ALEPH_VM_RELAY_PEER_ID", "", env),
        probe_multiaddrs:
          parseOptionalJson<string[]>(env.ALEPH_VM_PROBE_MULTIADDRS_JSON) ?? [],
        browser_bootstrap_multiaddrs:
          parseOptionalJson<string[]>(
            env.ALEPH_VM_BROWSER_BOOTSTRAP_MULTIADDRS_JSON,
          ) ?? [],
      },
    },
    verification: parseOptionalJson<Record<string, unknown>>(
      env.ALEPH_VM_VERIFICATION_JSON,
    ) ?? {
      ok: false,
      state: "scaffold",
    },
  };
}

export async function runActionMode(
  env: NodeJS.ProcessEnv = process.env,
  hooks: {
    stdout?: (text: string) => void;
    listGeocodedCrns?: typeof listGeocodedCrns;
    deployExecutor?: typeof executeDeployPlan;
    deriveUcanStoreBootstrapPackage?: typeof deriveUcanStoreBootstrapPackageFromEnv;
    retainSuccessfulDeployments?: typeof retainSuccessfulDeployments;
    publishRelayBootstrapRegistration?: typeof publishRelayBootstrapRegistration;
    createPrivateKeyIdentity?: (
      privateKey: string,
    ) => Promise<PrivateKeyIdentity>;
  } = {},
): Promise<void> {
  const mode = optionalEnv("ALEPH_VM_MODE", "deploy", env);
  const stdout = hooks.stdout ?? ((text: string) => process.stdout.write(text));

  if (mode === "list-crns") {
    if (
      !parseOptionalJson<unknown[]>(env.ALEPH_VM_GEOCRN_PAYLOAD_JSON) &&
      typeof globalThis.fetch !== "function"
    ) {
      throw new Error(
        "A fetch implementation is required for list-crns mode when no CRN payload is pre-supplied.",
      );
    }

    const payload =
      parseOptionalJson<unknown[]>(env.ALEPH_VM_GEOCRN_PAYLOAD_JSON) ??
      (await (hooks.listGeocodedCrns ?? listGeocodedCrns)({
        url: optionalEnv("ALEPH_VM_CRN_LIST_URL", undefined, env) || undefined,
        limit: Number(optionalEnv("ALEPH_VM_GEO_CRN_LIMIT", "30", env)),
        fetch: globalThis.fetch.bind(globalThis),
      }));
    await emitGeocodedCrnOutputs(payload, env);
    stdout(`${JSON.stringify(payload)}\n`);
    return;
  }

  if (mode === "retain-successful-deployments") {
    if (typeof globalThis.fetch !== "function") {
      throw new Error(
        "A fetch implementation is required for retain-successful-deployments mode.",
      );
    }

    const identity = await (
      hooks.createPrivateKeyIdentity ?? createPrivateKeyIdentity
    )(requiredEnv("ALEPH_VM_PRIVATE_KEY", env));
    const currentRecord = jsonEnv<unknown>(
      "ALEPH_VM_RETENTION_CURRENT_RECORD_JSON",
      "{}",
      env,
    );
    const keepCount = integerEnv("ALEPH_VM_RETENTION_KEEP_COUNT", 2, env);
    const extraForgetHashes = jsonEnv<string[]>(
      "ALEPH_VM_RETENTION_EXTRA_FORGET_HASHES_JSON",
      "[]",
      env,
    );
    const channel = optionalEnv("ALEPH_VM_CHANNEL", "TEST", env);
    const { result: payload } = await withApiHostFallback({
      label: "retention",
      fallbackApiHost: optionalEnv("ALEPH_VM_API_HOST", "https://api.aleph.im", env),
      env,
      run: async (apiHost) => (
        hooks.retainSuccessfulDeployments ?? retainSuccessfulDeployments
      )({
        sender: identity.address,
        currentRecord,
        keepCount,
        extraForgetHashes,
        signer: identity.signer,
        hasher: async (content) => defaultHasher(content),
        fetch: globalThis.fetch.bind(globalThis),
        channel,
        apiHost,
      }),
    });

    await appendGithubOutput(
      "retention_result_json",
      JSON.stringify(payload),
      env,
    );
    await appendGithubOutput(
      "retention_forget_hashes_json",
      JSON.stringify(payload.forgetHashes ?? []),
      env,
    );
    await appendGithubOutput(
      "retention_pruned_count",
      payload.prunedRecords?.length ?? 0,
      env,
    );
    await appendGithubOutput(
      "retention_retained_count",
      payload.retainedRecords?.length ?? 0,
      env,
    );
    await appendGithubSummary(
      [
        "## Successful deployment retention",
        "",
        `- Keep count: \`${payload.keepCount}\``,
        `- Retained deployments: \`${payload.retainedRecords?.length ?? 0}\``,
        `- Pruned deployments: \`${payload.prunedRecords?.length ?? 0}\``,
        `- Forgotten hashes: \`${(payload.forgottenHashes ?? payload.forgetHashes ?? []).length}\``,
        `- Outstanding forget hashes: \`${(payload.outstandingForgetHashes ?? []).length}\``,
      ],
      env,
    );
    stdout(`${JSON.stringify(payload)}\n`);
    return;
  }

  if (mode === "refresh-bootstrap") {
    if (typeof globalThis.fetch !== "function") {
      throw new Error(
        "A fetch implementation is required for refresh-bootstrap mode.",
      );
    }

    const publisherIdentity = await (
      hooks.createPrivateKeyIdentity ?? createPrivateKeyIdentity
    )(
      optionalEnv(
        "ALEPH_VM_PUBLISHER_PRIVATE_KEY",
        requiredEnv("ALEPH_VM_PRIVATE_KEY", env),
        env,
      ),
    );
    const ownerPrivateKey = env.ALEPH_VM_OWNER_PRIVATE_KEY?.trim();
    const ownerIdentity = ownerPrivateKey
      ? await (hooks.createPrivateKeyIdentity ?? createPrivateKeyIdentity)(
          ownerPrivateKey,
        )
      : null;

    const peerId = requiredEnv("ALEPH_VM_RELAY_PEER_ID", env);
    const multiaddrs = jsonEnv<string[]>(
      "ALEPH_VM_PROBE_MULTIADDRS_JSON",
      "[]",
      env,
    );
    const browserMultiaddrs = jsonEnv<string[]>(
      "ALEPH_VM_BROWSER_BOOTSTRAP_MULTIADDRS_JSON",
      "[]",
      env,
    );
    const profile = optionalEnv("ALEPH_VM_PROFILE", "uc-go-peer", env);
    const relayName = requiredEnv("ALEPH_VM_NAME", env);
    const instanceItemHash = optionalEnv("ALEPH_VM_INSTANCE_ITEM_HASH", "", env);
    const instanceOwnerAddress = optionalEnv(
      "ALEPH_VM_INSTANCE_OWNER_ADDRESS",
      optionalEnv("ALEPH_VM_DEPLOYER_ADDRESS", "", env),
      env,
    );
    const shouldReconcileOwner =
      optionalEnv("ALEPH_VM_BOOTSTRAP_RECONCILE_OWNER", "", env)
        .toLowerCase() !== "false" && !!instanceOwnerAddress;
    const registrationId = optionalEnv(
      "ALEPH_VM_BOOTSTRAP_REGISTRATION_ID",
      createRelayBootstrapRegistrationId(profile, relayName, instanceItemHash),
      env,
    );

    const forgetPrevious = optionalEnv(
      "ALEPH_VM_BOOTSTRAP_FORGET_PREVIOUS",
      "true",
      env,
    ).toLowerCase() !== "false";
    const version = optionalEnv("ALEPH_VM_ROOTFS_VERSION", "", env) || undefined;
    const { result: bootstrapResult } = await withApiHostFallback({
      label: "bootstrap refresh",
      fallbackApiHost: optionalEnv("ALEPH_VM_API_HOST", "https://api.aleph.im", env),
      env,
      run: async (apiHost) => {
        const publication = await (
          hooks.publishRelayBootstrapRegistration ?? publishRelayBootstrapRegistration
        )({
          sender: publisherIdentity.address,
          signer: publisherIdentity.signer,
          hasher: async (content) => defaultHasher(content),
          fetch: globalThis.fetch.bind(globalThis),
          apiHost,
          peerId,
          multiaddrs,
          browserMultiaddrs,
          ownerAddress: ownerIdentity?.address,
          publisherAddress: publisherIdentity.address,
          ownerSigner: ownerIdentity?.signer,
          publisherSigner: publisherIdentity.signer,
          registrationId,
          forgetPrevious,
          profile,
          version,
          sync: true,
        });
        const reconcileResult = shouldReconcileOwner
          ? await reconcileOwnerRelayBootstrapRegistrations({
              instanceOwnerAddress,
              sender: publisherIdentity.address,
              signer: publisherIdentity.signer,
              hasher: async (content) => defaultHasher(content),
              fetch: globalThis.fetch.bind(globalThis),
              apiHost,
              profile,
              ownerAddress: ownerIdentity?.address,
              ownerSigner: ownerIdentity?.signer,
              publisherAddress: publisherIdentity.address,
              publisherSigner: publisherIdentity.signer,
              current: instanceItemHash
                ? {
                    itemHash: instanceItemHash,
                    registrationId,
                    peerId,
                    probeMultiaddrs: multiaddrs,
                    browserBootstrapMultiaddrs: browserMultiaddrs,
                  }
                : null,
            })
          : {
              refreshedRegistrations: [],
              forgottenHashes: [],
              skippedInstanceHashes: [],
              errors: [],
            };
        return { publication, reconcileResult };
      },
    });
    const { publication, reconcileResult } = bootstrapResult;

    await appendGithubOutput(
      "bootstrap_registration_json",
      JSON.stringify(publication),
      env,
    );
    await appendGithubOutput(
      "bootstrap_registration_item_hash",
      publication.itemHash ?? "",
      env,
    );
    await appendGithubOutput(
      "bootstrap_registration_status",
      publication.status,
      env,
    );
    await appendGithubOutput(
      "bootstrap_reconcile_result_json",
      JSON.stringify(reconcileResult),
      env,
    );
    await appendGithubSummary(
      [
        "## Aleph bootstrap refresh",
        "",
        `- Profile: \`${profile}\``,
        `- Relay name: \`${relayName}\``,
        `- Peer ID: \`${peerId}\``,
        `- Published status: \`${publication.status}\``,
        `- Published item hash: \`${publication.itemHash ?? "unknown"}\``,
        `- Forgotten previous hashes: \`${publication.forgottenHashes?.length ?? 0}\``,
        `- Reconciled registrations: \`${reconcileResult.refreshedRegistrations.length}\``,
        `- Reconcile warnings: \`${reconcileResult.errors.length}\``,
      ],
      env,
    );
    stdout(`${JSON.stringify({ publication, reconcile: reconcileResult })}\n`);
    return;
  }

  if (mode !== "deploy") {
    throw new Error(
      `Unsupported ALEPH_VM_MODE "${mode}" in Aleph action runner.`,
    );
  }

  const providedDeployResult = parseOptionalJson<DeployOutputResult>(
    env.ALEPH_VM_DEPLOY_RESULT_JSON,
  );
  let deployResult: DeployOutputResult | null = providedDeployResult;
  if (!deployResult) {
    try {
      if (shouldDeriveUcanStoreBootstrapPackage(env)) {
        const bootstrapPackage = await (
          hooks.deriveUcanStoreBootstrapPackage ??
          deriveUcanStoreBootstrapPackageFromEnv
        )(env);
        env.ALEPH_VM_UCAN_STORE_BOOTSTRAP_JSON =
          JSON.stringify(bootstrapPackage);
        env.ALEPH_VM_ADMIN_DID =
          env.ALEPH_VM_ADMIN_DID?.trim() || bootstrapPackage.adminDid;
        await appendGithubOutput(
          "ucan_store_bootstrap_admin_did",
          bootstrapPackage.adminDid,
          env,
        );
        await appendGithubOutput(
          "ucan_store_bootstrap_space_did",
          bootstrapPackage.spaceDid,
          env,
        );
        await appendGithubSummary(
          [
            "### ucan-store Bootstrap",
            "",
            "- Mode: `derive-from-aleph-private-key`",
            `- Admin DID: \`${bootstrapPackage.adminDid}\``,
            `- Space DID: \`${bootstrapPackage.spaceDid}\``,
            `- Service DID: \`${bootstrapPackage.serviceDid ?? "runtime-derived"}\``,
          ],
          env,
        );
      }
      const deployPlan = parseDeployPlan(env);
      const resolvedDeployPlan = await resolveDeployPlanRootfs(
        deployPlan,
        globalThis.fetch.bind(globalThis),
      );
      deployResult = await executeDeployPlanWithApiHostFallback({
        plan: resolvedDeployPlan,
        env,
        deployExecutor: hooks.deployExecutor ?? executeDeployPlan,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("Missing required environment variable")
      ) {
        deployResult = buildScaffoldDeployResult(env);
      } else {
        throw error;
      }
    }
  }

  if (!deployResult) {
    throw new Error("Aleph action runner did not produce a deploy result.");
  }

  await emitDeployOutputs(deployResult, env);
  await appendGithubOutput("action_runner_mode", mode, env);
  await appendGithubOutput(
    "action_runner_profile",
    optionalEnv("ALEPH_VM_PROFILE", "uc-go-peer", env),
    env,
  );
  await appendGithubSummary(
    [
      "",
      "### Aleph Action Runner",
      "",
      `- Mode: \`${mode}\``,
      `- Profile: \`${optionalEnv("ALEPH_VM_PROFILE", "uc-go-peer", env)}\``,
    ],
    env,
  );
  actionLog(
    "notice",
    `Aleph action runner executed in ${mode} mode for profile ${optionalEnv("ALEPH_VM_PROFILE", "uc-go-peer", env)}.`,
  );
  stdout(`${JSON.stringify(deployResult)}\n`);
}

export async function main(): Promise<void> {
  await runActionMode(process.env);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    actionLog("error", message);
    process.exitCode = 1;
  });
}
