import type { MessageReference } from "./runtime";

export interface DeploymentResult {
  itemHash: string;
  httpStatus?: number;
  status: "processed" | "pending" | "rejected" | "unknown";
  message?: AlephBroadcastMessage;
  response?: AlephBroadcastResponse;
  rejectionReason?: string | null;
}

export type DeploymentProgressStage =
  | "idle"
  | "validating"
  | "loading-manifest"
  | "verifying-rootfs"
  | "loading-pricing"
  | "loading-balance"
  | "selecting-crn"
  | "building-message"
  | "signing-message"
  | "broadcasting"
  | "notifying-crn"
  | "preparing-confidential"
  | "attesting-guest"
  | "unlocking-guest"
  | "waiting-for-aleph"
  | "deployment-confirmed"
  | "deployment-rejected"
  | "publishing-bootstrap"
  | "building-delete-message"
  | "signing-delete-message"
  | "broadcasting-delete"
  | "delete-completed"
  | "refreshing-instances"
  | "completed"
  | "error";

export interface DeploymentProgressEvent {
  stage: DeploymentProgressStage;
  label: string;
  progress: number;
  status: "info" | "success" | "warning" | "error";
  itemHash?: string | null;
  detail?: string | null;
  error?: string | null;
  timestamp: number;
}

export type DeploymentProgressListener = (
  event: DeploymentProgressEvent,
) => void;

export type AlephSenderChain = "ETH";
export type AlephMessageType = "INSTANCE" | "FORGET" | "AGGREGATE" | "STORE" | "POST";

export interface AlephBroadcastMessage {
  sender: string;
  chain: AlephSenderChain;
  signature: string;
  type: AlephMessageType;
  item_hash: string;
  item_type: "inline";
  item_content: string;
  time: number;
  channel: string;
}

export interface AlephBroadcastResponse {
  publication_status?: {
    status: string;
    failed?: unknown[];
  };
  message_status?: "processed" | "pending" | "rejected" | "unknown";
  details?: unknown;
  [key: string]: unknown;
}

export interface AlephAggregateContent<T = Record<string, unknown>> {
  address: string;
  key: string;
  content: T;
  time: number;
}

/** TEE mode on the wire; absent or "sev" is the legacy SEV / SEV-ES flow. */
export type TeeMode = "sev" | "sev_snp" | "tdx";

/** Expected launch registers of a measured mode (sev_snp declares `launch`). */
export interface LaunchMeasurement {
  platform: "sev_snp" | "tdx";
  registers: Record<string, string>;
  /** QEMU CPU model the registers were computed for, e.g. "EPYC-v4". */
  vcpu_type?: string;
}

/**
 * `environment.trusted_execution` of a confidential instance, as aleph-rs
 * (`aleph-types`, TrustedExecutionEnvironment) serialises it. Legacy SEV uses
 * `firmware` and `policy`; the measured modes (sev_snp, tdx) need `runtime`
 * and `measurements` instead.
 */
export interface TrustedExecution {
  /** OVMF firmware item hash (legacy SEV only). */
  firmware?: string;
  /** AMD SEV policy bits (legacy) or the SEV-SNP 64-bit guest policy. */
  policy?: number;
  mode?: TeeMode;
  /** STORE item hash of the measured runtime bundle (measured modes only). */
  runtime?: string;
  measurements?: LaunchMeasurement[];
  /** In-guest attestation port; the runtime bundle's default (8443) if absent. */
  attestation_port?: number;
}

export interface AlephInstanceContent {
  address: string;
  time: number;
  allow_amend: boolean;
  metadata?: { name: string; [key: string]: string | number | boolean };
  authorized_keys?: string[];
  environment: {
    internet: boolean;
    aleph_api: boolean;
    reproducible?: boolean;
    shared_cache?: boolean;
    hypervisor: "qemu";
    trusted_execution?: TrustedExecution;
  };
  resources: {
    vcpus: number;
    memory: number;
    seconds: number;
  };
  payment: {
    chain?: string;
    receiver?: string;
    type: string;
  };
  requirements?: {
    node?: {
      node_hash: string;
    };
  };
  volumes: unknown[];
  rootfs: {
    parent: {
      ref: string;
      use_latest?: boolean;
    };
    persistence: "host" | "store";
    size_mib: number;
  };
}

export interface DeploymentIntent {
  ownerAddress: string;
  messageTime: number;
  itemHash: string;
  paymentType: string;
  rootfsRef: string;
  rootfsSizeMiB: number;
  computeUnits: number;
  vcpus: number;
  memoryMiB: number;
  crnHash: string | null;
  channel: string;
  expiresAt: number;
  maxCost: string;
}

export interface DeploymentIntentEnvelope {
  intent: DeploymentIntent;
  intentHash: string;
}

export interface MessageInspectionResult {
  status: "processed" | "pending" | "rejected" | "removing" | "removed" | "unknown";
  errorCode: number | null;
  details: Record<string, unknown> | null;
  rejectionReason: string | null;
}

export interface DeploymentInspectionResult extends MessageInspectionResult {
  references: MessageReference[];
}

export type MessageSigner = (
  sender: string,
  payload: string,
) => Promise<string>;

export type MessageHasher = (payload: string) => Promise<string> | string;
