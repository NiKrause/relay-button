import type { SponsorRelayRootfsHealth } from "./types";
import type { DeploymentProgressEvent } from "../../../shared-types/src/deployment.ts";

export const DEFAULT_INSTANCE_NAME = "sponsor-relay";
export const DEFAULT_MANIFEST_URL = "./rootfs-manifest.json";
export const DEFAULT_TIER_ID = "tier-1";
export const ROOTFS_MISSING_STATE: SponsorRelayRootfsHealth = {
  tone: "idle",
  label: "manifest missing",
  detail: "Provide a manifest URL or paste manifest JSON.",
};
export const IDLE_DEPLOYMENT_PROGRESS: DeploymentProgressEvent = {
  stage: "idle",
  label: "Ready",
  progress: 0,
  status: "info",
  itemHash: null,
  detail: null,
  error: null,
  timestamp: Date.now(),
};
export const REFRESH_INTERVAL_MS = 30_000;
export const MANIFEST_SOURCE_REFRESH_DEBOUNCE_MS = 400;
export const INSTANCE_RUNTIME_READY_REFRESH_MS = 30_000;
export const INSTANCE_RUNTIME_PENDING_REFRESH_MS = 45_000;
export const INSTANCE_RUNTIME_STALE_REFRESH_MS = 5 * 60_000;
export const STALE_INSTANCE_ALLOCATION_COOLDOWN_MS = 5 * 60 * 1000;
export const RECENT_INSTANCE_RUNTIME_GRACE_MS = 10 * 60 * 1000;
export const DEPLOYMENT_PENDING_WARNING_MS = 3 * 60 * 1000;
