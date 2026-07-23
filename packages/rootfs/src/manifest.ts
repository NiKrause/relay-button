import { dirname, extname, isAbsolute, join } from "node:path";

import type { RootfsBuildPlan } from "./build-plan.ts";
import type { RootfsContract } from "./contract.ts";

export interface RootfsManifest {
  profile: string;
  version: string;
  rootfsInstallStrategy: string;
  requiresBootstrapNetwork: boolean;
  /** Guest fetches its bootstrap config from the Aleph aggregate itself. */
  supportsBootstrapConfigAggregate?: boolean;
  bootstrapSummary: string;
  rootfsSourceSizeBytes?: number;
  requiredPortForwards: RootfsContract["ports"];
  rootfsCid?: string;
  rootfsItemHash?: string;
  rootfsSizeMiB: number;
  createdAt: string;
  notes: string;
  playwrightVersion?: string;
}

export interface RootfsManifestOptions {
  createdAt?: string;
  rootfsCid?: string;
  rootfsItemHash?: string;
  rootfsSourceSizeBytes?: number;
}

export interface RootfsManifestOutputPaths {
  primaryPath: string;
  copyTargetPath?: string;
  versionedTargetPath?: string;
}

export interface RootfsManifestState {
  manifest: RootfsManifest | null;
  valid: boolean;
  errors: string[];
}

export const ITEM_HASH_RE = /^[a-fA-F0-9]{64}$/u;

export function validateRootfsManifest(manifest: RootfsManifest | null): RootfsManifestState {
  const errors: string[] = [];

  if (!manifest) {
    return { manifest, valid: false, errors: ["Rootfs manifest is missing."] };
  }

  if (!manifest.version) errors.push("Rootfs manifest version is missing.");
  if (manifest.profile === "playwright-runner" && !/^\d+\.\d+\.\d+$/u.test(manifest.playwrightVersion ?? "")) {
    errors.push("Playwright runner manifest must expose an exact Playwright version.");
  }
  if (
    manifest.rootfsInstallStrategy != null &&
    manifest.rootfsInstallStrategy !== "thin" &&
    manifest.rootfsInstallStrategy !== "prebaked"
  ) {
    errors.push('Rootfs install strategy must be "thin" or "prebaked" when provided.');
  }
  if (manifest.requiresBootstrapNetwork != null && typeof manifest.requiresBootstrapNetwork !== "boolean") {
    errors.push("Rootfs bootstrap network flag must be a boolean when provided.");
  }
  if (manifest.bootstrapSummary != null && !manifest.bootstrapSummary.trim()) {
    errors.push("Rootfs bootstrap summary must be non-empty when provided.");
  }
  if (manifest.requiredPortForwards != null) {
    if (!Array.isArray(manifest.requiredPortForwards)) {
      errors.push("Rootfs required port forwards must be an array when provided.");
    } else {
      manifest.requiredPortForwards.forEach((entry, index) => {
        if (!entry || typeof entry !== "object") {
          errors.push(`Rootfs required port forward #${index + 1} must be an object.`);
          return;
        }

        if (!Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535) {
          errors.push(`Rootfs required port forward #${index + 1} must use a TCP/UDP port between 1 and 65535.`);
        }
        if (entry.tcp !== true && entry.udp !== true) {
          errors.push(`Rootfs required port forward #${index + 1} must enable TCP or UDP.`);
        }
        if (entry.purpose != null && (typeof entry.purpose !== "string" || !entry.purpose.trim())) {
          errors.push(`Rootfs required port forward #${index + 1} purpose must be non-empty when provided.`);
        }
      });
    }
  }
  if (!ITEM_HASH_RE.test(manifest.rootfsItemHash || "")) {
    errors.push("Rootfs ItemHash must be a 64 character hex value.");
  }
  if (!Number.isInteger(manifest.rootfsSizeMiB) || manifest.rootfsSizeMiB <= 0) {
    errors.push("Rootfs size must be a positive MiB integer.");
  }
  if (
    manifest.rootfsSourceSizeBytes != null &&
    (!Number.isInteger(manifest.rootfsSourceSizeBytes) || manifest.rootfsSourceSizeBytes <= 0)
  ) {
    errors.push("Rootfs source size must be a positive byte integer when provided.");
  }
  if (!manifest.createdAt || Number.isNaN(new Date(manifest.createdAt).getTime())) {
    errors.push("Rootfs creation date is missing or invalid.");
  }

  return { manifest, valid: errors.length === 0, errors };
}

export function rootfsSourceSizeBytesFromIpfsAddResponse(content: string): number | undefined {
  const lines = content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return undefined;
  }

  const payload = JSON.parse(lines.at(-1) ?? "{}") as {
    Size?: string | number;
  };
  const size = payload.Size;
  if (typeof size === "number" && Number.isFinite(size) && size > 0) {
    return size;
  }
  if (typeof size === "string" && /^\d+$/u.test(size)) {
    return Number(size);
  }
  return undefined;
}

export function createRootfsManifest(
  plan: RootfsBuildPlan,
  contract: RootfsContract,
  options: RootfsManifestOptions = {},
): RootfsManifest {
  const manifest: RootfsManifest = {
    profile: contract.rootfs.profile,
    version: plan.rootfsVersion,
    rootfsInstallStrategy: contract.rootfs.installMode,
    requiresBootstrapNetwork: false,
    bootstrapSummary: "Dependencies are preinstalled in the image.",
    requiredPortForwards: contract.ports,
    rootfsSizeMiB: plan.rootfsSizeMiB,
    createdAt: options.createdAt ?? new Date().toISOString(),
    notes: contract.manifest.notes ?? "",
  };

  if (contract.rootfs.profile === "playwright-runner") {
    manifest.playwrightVersion = "1.61.1";
  }

  // Profiles whose guest setup server fetches its own bootstrap config from
  // the Aleph aggregate (locating it via the deployment token in its SSH
  // key) instead of waiting for the browser to POST it over plain HTTP.
  // The browser needs this to deploy from an HTTPS origin at all, since a
  // HTTPS page cannot call the guest's plain-HTTP setup endpoint.
  //
  // Only declare it for images that really implement the guest-side fetch —
  // announcing it early would make the browser publish the aggregate and
  // then wait for an acknowledgement the guest never sends. `orbitdb-relay`
  // joins once its setup server gains the same fetch (see #61).
  if (contract.rootfs.profile === "uc-go-peer") {
    manifest.supportsBootstrapConfigAggregate = true;
  }

  if (
    typeof options.rootfsSourceSizeBytes === "number" &&
    Number.isFinite(options.rootfsSourceSizeBytes) &&
    options.rootfsSourceSizeBytes > 0
  ) {
    manifest.rootfsSourceSizeBytes = options.rootfsSourceSizeBytes;
  }
  if (options.rootfsCid) {
    manifest.rootfsCid = options.rootfsCid;
  }
  if (options.rootfsItemHash) {
    manifest.rootfsItemHash = options.rootfsItemHash;
  }

  return manifest;
}

export function resolveRootfsManifestOutputPaths(plan: RootfsBuildPlan): RootfsManifestOutputPaths {
  const paths: RootfsManifestOutputPaths = {
    primaryPath: plan.manifestPath,
  };

  const copyTarget = plan.latestManifestPath;
  if (!copyTarget) {
    return paths;
  }

  const resolvedCopyTarget = isAbsolute(copyTarget) ? copyTarget : join(plan.projectDir, copyTarget);
  paths.copyTargetPath = resolvedCopyTarget;

  const copyTargetExt = extname(resolvedCopyTarget) || ".json";
  paths.versionedTargetPath = join(dirname(resolvedCopyTarget), `${plan.rootfsVersion}${copyTargetExt}`);
  return paths;
}

export function serializeRootfsManifest(manifest: RootfsManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
