import type { SponsorRelayRootfsHealth } from "./types";
import type { DeploymentProgressEvent } from "../../../shared-types/src/deployment.ts";

/** Where the widget's own source lives; the panel links to it next to the version. */
export const UI_SOURCE_URL = "https://github.com/NiKrause/relay-button";
/** GitHub's mark (Octicons `mark-github`, 16×16 viewBox). */
export const GITHUB_MARK_PATH =
  "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z";

/** `sourceUrl` resolved: unset means the widget's repository, empty or null hides the link. */
export function resolveSourceUrl(sourceUrl: string | null | undefined): string | null {
  if (sourceUrl === undefined) return UI_SOURCE_URL;
  const trimmed = (sourceUrl ?? "").trim();
  return trimmed || null;
}

export const DEFAULT_INSTANCE_NAME = "sponsor-relay";
export const DEFAULT_MANIFEST_URL = "./rootfs-manifest.json";
export const DEFAULT_TIER_ID = "tier-1";
export const DEFAULT_UCAN_STORE_PWA_ORIGIN = "https://ucan.nicokrause.com";
export const DEFAULT_UCAN_STORE_SERVICE_ORIGIN = "https://ucan-api.nicokrause.com";
export const DEFAULT_UCAN_STORE_SERVICE_DID = "did:web:ucan-api.nicokrause.com";
export const DEFAULT_UCAN_STORE_ALLOWED_CAPABILITIES = [
  "space/blob/add",
  "space/blob/list",
  "space/index/add",
  "space/index/list",
  "filecoin/offer",
  "upload/add",
  "upload/list",
  "store/add",
];
export const DEFAULT_UCAN_STORE_USER_DELEGATION_EXPIRATION_SECONDS = "31536000";
export const DEFAULT_UCAN_STORE_MAX_DELEGATION_EXPIRATION_SECONDS = "315360000";
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
