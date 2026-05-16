import { dirname, extname, isAbsolute, join } from "node:path";

import type { RootfsBuildPlan } from "./build-plan.ts";
import type { RootfsContract } from "./contract.ts";

export interface RootfsManifest {
  profile: string;
  version: string;
  rootfsInstallStrategy: string;
  requiresBootstrapNetwork: boolean;
  bootstrapSummary: string;
  rootfsSourceSizeBytes?: number;
  requiredPortForwards: RootfsContract["ports"];
  rootfsCid?: string;
  rootfsItemHash?: string;
  rootfsSizeMiB: number;
  createdAt: string;
  notes: string;
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

export function rootfsSourceSizeBytesFromIpfsAddResponse(content: string): number | undefined {
  const lines = content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return undefined;
  }

  const payload = JSON.parse(lines.at(-1) ?? "{}") as { Size?: string | number };
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
    notes: contract.manifest.notes,
  };

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
