import type {
  RootfsManifest,
  RootfsRequiredPortForward,
  UcanStoreBootstrapPackage,
} from "@le-space/shared-types";
import { validateUcanStoreBootstrapPackage } from "@le-space/shared-types";

import {
  validateRootfsManifest,
  type FetchLike,
} from "../../core/src/index.ts";

import {
  booleanEnv,
  integerEnv,
  jsonEnv,
  optionalEnv,
  requiredEnv,
} from "./env.ts";

export interface DeployPlan {
  profile: string;
  adminDid?: string;
  ucanStoreBootstrapPackage?: UcanStoreBootstrapPackage;
  privateKey: string;
  bootstrapPublisherPrivateKey: string;
  bootstrapOwnerPrivateKey: string;
  apiHost: string;
  crnListUrl: string;
  name: string;
  sshPublicKey: string;
  rootfsManifestUrl: string;
  rootfsItemHash: string;
  rootfsVersion: string;
  rootfsSizeMiB: number;
  crnHash: string;
  preferredCountryCode: string;
  geoCrnLimit: number;
  maxCrnAttempts: number;
  vcpus: number;
  memoryMiB: number;
  seconds: number;
  channel: string;
  waitAttempts: number;
  waitDelayMs: number;
  runtimeAttempts: number;
  runtimeDelayMs: number;
  setupAttempts: number;
  setupDelayMs: number;
  verifyAttempts: number;
  verifyDelayMs: number;
  tcpTimeoutMs: number;
  httpTimeoutMs: number;
  metadataAttempts: number;
  metadataDelayMs: number;
  metadataTimeoutMs: number;
  configureTimeoutMs: number;
  enableCaddyProxy: boolean;
  autoConfigure: boolean;
  verifyReachability: boolean;
  requiredPorts: RootfsRequiredPortForward[];
  publishPortForwards: boolean;
}

function isValidRequiredPortForward(
  value: unknown,
): value is RootfsRequiredPortForward {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;

  const candidate = value as {
    port?: unknown;
    tcp?: unknown;
    udp?: unknown;
    purpose?: unknown;
  };

  return (
    Number.isInteger(candidate.port) &&
    Number(candidate.port) > 0 &&
    typeof candidate.tcp === "boolean" &&
    typeof candidate.udp === "boolean" &&
    (candidate.purpose == null || typeof candidate.purpose === "string")
  );
}

function parseRequiredPorts(
  env: NodeJS.ProcessEnv = process.env,
): RootfsRequiredPortForward[] {
  const requiredPorts = jsonEnv<unknown>(
    "ALEPH_VM_REQUIRED_PORTS_JSON",
    "[]",
    env,
  );

  if (!Array.isArray(requiredPorts)) {
    throw new Error(
      'ALEPH_VM_REQUIRED_PORTS_JSON must be a JSON array of objects like {"port":22,"tcp":true,"udp":false,"purpose":"SSH"}.',
    );
  }

  const invalidIndex = requiredPorts.findIndex(
    (entry) => !isValidRequiredPortForward(entry),
  );
  if (invalidIndex !== -1) {
    throw new Error(
      `ALEPH_VM_REQUIRED_PORTS_JSON entry ${invalidIndex} is invalid. Expected objects like {"port":22,"tcp":true,"udp":false,"purpose":"SSH"}, not raw port numbers.`,
    );
  }

  return requiredPorts;
}

function parseUcanStoreBootstrapPackage(
  env: NodeJS.ProcessEnv = process.env,
): UcanStoreBootstrapPackage | undefined {
  const raw = optionalEnv("ALEPH_VM_UCAN_STORE_BOOTSTRAP_JSON", "", env).trim();
  if (!raw) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `ALEPH_VM_UCAN_STORE_BOOTSTRAP_JSON must be valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const result = validateUcanStoreBootstrapPackage(parsed);
  if (!result.valid || !result.bootstrapPackage) {
    throw new Error(
      `ALEPH_VM_UCAN_STORE_BOOTSTRAP_JSON is invalid: ${result.errors.join(" ")}`,
    );
  }

  return result.bootstrapPackage;
}

export async function loadRootfsManifestForDeploy(args: {
  manifestUrl: string;
  fetch: FetchLike;
}): Promise<RootfsManifest> {
  const response = await args.fetch(args.manifestUrl, {
    cache: "no-cache",
  });

  if (!response.ok) {
    throw new Error(
      `Rootfs manifest request failed: ${response.status} (${args.manifestUrl})`,
    );
  }

  const payload = (await response.json()) as RootfsManifest;
  const state = validateRootfsManifest(payload);
  if (!state.valid || !state.manifest) {
    throw new Error(`Rootfs manifest is invalid: ${state.errors.join(" ")}`);
  }

  if (!state.manifest.rootfsItemHash) {
    throw new Error(
      "Rootfs manifest must include rootfsItemHash for CLI deployment.",
    );
  }

  return state.manifest;
}

export async function resolveDeployPlanRootfs(
  plan: DeployPlan,
  fetch: FetchLike,
): Promise<DeployPlan> {
  if (!plan.rootfsManifestUrl) {
    return plan;
  }

  const manifest = await loadRootfsManifestForDeploy({
    manifestUrl: plan.rootfsManifestUrl,
    fetch,
  });

  return {
    ...plan,
    profile: manifest.profile?.trim() || plan.profile,
    rootfsItemHash: manifest.rootfsItemHash ?? plan.rootfsItemHash,
    rootfsVersion: manifest.version || plan.rootfsVersion,
    rootfsSizeMiB: manifest.rootfsSizeMiB,
    requiredPorts:
      Array.isArray(manifest.requiredPortForwards) &&
      manifest.requiredPortForwards.length > 0
        ? manifest.requiredPortForwards
        : plan.requiredPorts,
  };
}

export function parseDeployPlan(
  env: NodeJS.ProcessEnv = process.env,
): DeployPlan {
  const rootfsManifestUrl = optionalEnv(
    "ALEPH_VM_ROOTFS_MANIFEST_URL",
    "",
    env,
  ).trim();
  const rootfsItemHash = optionalEnv("ALEPH_VM_ROOTFS_ITEM_HASH", "", env);

  if (!rootfsManifestUrl && !rootfsItemHash) {
    throw new Error(
      "Missing required environment variable ALEPH_VM_ROOTFS_ITEM_HASH (or set ALEPH_VM_ROOTFS_MANIFEST_URL).",
    );
  }

  const requiredPorts = parseRequiredPorts(env);
  const ucanStoreBootstrapPackage = parseUcanStoreBootstrapPackage(env);

  return {
    profile: optionalEnv("ALEPH_VM_PROFILE", "uc-go-peer", env),
    adminDid:
      optionalEnv("ALEPH_VM_ADMIN_DID", "", env).trim() ||
      ucanStoreBootstrapPackage?.adminDid ||
      undefined,
    ucanStoreBootstrapPackage,
    privateKey: requiredEnv("ALEPH_VM_PRIVATE_KEY", env),
    bootstrapPublisherPrivateKey: optionalEnv(
      "ALEPH_VM_BOOTSTRAP_PUBLISHER_PRIVATE_KEY",
      "",
      env,
    ),
    bootstrapOwnerPrivateKey: optionalEnv(
      "ALEPH_VM_BOOTSTRAP_OWNER_PRIVATE_KEY",
      "",
      env,
    ),
    apiHost: optionalEnv("ALEPH_VM_API_HOST", "https://api.aleph.im", env),
    crnListUrl: optionalEnv(
      "ALEPH_VM_CRN_LIST_URL",
      "https://crns-list.aleph.sh/crns.json",
      env,
    ),
    name: requiredEnv("ALEPH_VM_NAME", env),
    sshPublicKey: requiredEnv("ALEPH_VM_SSH_PUBLIC_KEY", env),
    rootfsManifestUrl,
    rootfsItemHash,
    rootfsVersion: optionalEnv("ALEPH_VM_ROOTFS_VERSION", "", env),
    rootfsSizeMiB: integerEnv("ALEPH_VM_ROOTFS_SIZE_MIB", 20480, env),
    crnHash: optionalEnv("ALEPH_VM_CRN_HASH", "", env),
    preferredCountryCode: optionalEnv(
      "ALEPH_VM_PREFERRED_COUNTRY_CODE",
      "DE",
      env,
    ),
    geoCrnLimit: integerEnv("ALEPH_VM_GEO_CRN_LIMIT", 30, env),
    maxCrnAttempts: integerEnv("ALEPH_VM_MAX_CRN_ATTEMPTS", 5, env),
    vcpus: integerEnv("ALEPH_VM_VCPUS", 1, env),
    memoryMiB: integerEnv("ALEPH_VM_MEMORY_MIB", 1024, env),
    seconds: integerEnv("ALEPH_VM_SECONDS", 30, env),
    channel: optionalEnv("ALEPH_VM_CHANNEL", "TEST", env),
    waitAttempts: integerEnv("ALEPH_VM_WAIT_ATTEMPTS", 60, env),
    waitDelayMs: integerEnv("ALEPH_VM_WAIT_DELAY_MS", 5000, env),
    runtimeAttempts: integerEnv("ALEPH_VM_RUNTIME_ATTEMPTS", 40, env),
    runtimeDelayMs: integerEnv("ALEPH_VM_RUNTIME_DELAY_MS", 5000, env),
    setupAttempts: integerEnv("ALEPH_VM_SETUP_ATTEMPTS", 15, env),
    setupDelayMs: integerEnv("ALEPH_VM_SETUP_DELAY_MS", 4000, env),
    verifyAttempts: integerEnv("ALEPH_VM_VERIFY_ATTEMPTS", 25, env),
    verifyDelayMs: integerEnv("ALEPH_VM_VERIFY_DELAY_MS", 5000, env),
    tcpTimeoutMs: integerEnv("ALEPH_VM_TCP_TIMEOUT_MS", 5000, env),
    httpTimeoutMs: integerEnv("ALEPH_VM_HTTP_TIMEOUT_MS", 10000, env),
    metadataAttempts: integerEnv("ALEPH_VM_METADATA_ATTEMPTS", 80, env),
    metadataDelayMs: integerEnv("ALEPH_VM_METADATA_DELAY_MS", 3000, env),
    metadataTimeoutMs: integerEnv("ALEPH_VM_METADATA_TIMEOUT_MS", 240000, env),
    configureTimeoutMs: integerEnv(
      "ALEPH_VM_CONFIGURE_TIMEOUT_MS",
      180000,
      env,
    ),
    enableCaddyProxy: booleanEnv("ALEPH_VM_ENABLE_CADDY_PROXY", false, env),
    autoConfigure: booleanEnv("ALEPH_VM_AUTO_CONFIGURE", true, env),
    verifyReachability: booleanEnv("ALEPH_VM_VERIFY_REACHABILITY", true, env),
    requiredPorts,
    publishPortForwards: booleanEnv(
      "ALEPH_VM_PUBLISH_PORT_FORWARDS",
      true,
      env,
    ),
  };
}
