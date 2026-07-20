import { bootstrap } from "@libp2p/bootstrap";
import { keccak256, recoverMessageAddress, stringToHex } from "viem";

export const DEFAULT_ALEPH_API_HOST = "https://api.aleph.im";
export const DEFAULT_ALEPH_BOOTSTRAP_CHANNEL = "simple-todo";
export const DEFAULT_ALEPH_BOOTSTRAP_REF = "simple-todo-bootstrap";
export const DEFAULT_ALEPH_BOOTSTRAP_POST_TYPE = "relay-bootstrap-v2";
export const DEFAULT_BOOTSTRAP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_BOOTSTRAP_PAGINATION = 50;
export const DEFAULT_BOOTSTRAP_MAX_PAGES = 5;
export const DEFAULT_BOOTSTRAP_COMPACT_MULTIADDR_LIMIT = 3;
export const RELAY_BOOTSTRAP_SIGNATURE_SCHEME = "personal_sign";

export interface RelayBootstrapAuthorizationPayload {
  ownerAddress: string;
  publisherAddress: string;
  peerId: string;
  registrationId?: string;
  profile?: string;
  version?: string;
  instanceItemHash?: string;
  issuedAt: number;
  expiresAt?: number;
}

export interface RelayBootstrapAuthorizationRecord {
  scheme: string;
  payload: RelayBootstrapAuthorizationPayload;
  signature: string;
}

export interface RelayBootstrapProofPayload {
  peerId: string;
  multiaddrs?: string[];
  browserMultiaddrs?: string[];
  multiaddrsHash?: string;
  browserMultiaddrsHash?: string;
  registrationId?: string;
  profile?: string;
  version?: string;
  updatedAt: number;
}

export interface RelayBootstrapProofRecord {
  scheme: string;
  payload: RelayBootstrapProofPayload;
  signature: string;
}

export interface RelayBootstrapVerificationResult {
  ok: boolean;
  errors: string[];
}

export type RelayBootstrapProofSigner = (
  address: string,
  payload: string,
) => Promise<string>;

export interface RelayBootstrapContent {
  peerId: string;
  multiaddrs: string[];
  browserMultiaddrs?: string[];
  registrationId?: string;
  profile?: string;
  version?: string;
  ownerAddress?: string;
  publisherAddress?: string;
  authorization?: RelayBootstrapAuthorizationRecord;
  relayProof?: RelayBootstrapProofRecord;
  updatedAt: number;
}

export interface RelayBootstrapPostContent {
  type: string;
  address: string;
  ref?: string;
  content: RelayBootstrapContent;
  time: number;
}

export interface RelayBootstrapPostRecord {
  hash: string | null;
  itemHash: string | null;
  address: string | null;
  ref: string | null;
  type: string | null;
  time: number | null;
  content: RelayBootstrapContent | null;
}

export interface DiscoverAlephBootstrapOptions {
  apiHost?: string;
  channel?: string;
  ref?: string;
  page?: number;
  pagination?: number;
  maxPages?: number;
  maxAgeMs?: number;
  compactMultiaddrLimit?: number;
  browserDialableOnly?: boolean;
  requireDualKeyAttestation?: boolean;
  verifyDualKeyAttestation?: boolean;
  /**
   * Restrict discovery to registrations published under this relay profile
   * (e.g. `"orbitdb-relay"`). Multiple relay implementations register in the
   * same Aleph channel; without this scope a consumer would pick up relays it
   * cannot use (an orbitdb app connecting to a `uc-go-peer` relay never gets a
   * shared circuit → `candidates: 0`). Accepts a single profile or a list.
   * When omitted, posts of every profile are returned (previous behaviour).
   */
  profile?: string | readonly string[];
  fetch?: typeof fetch;
}

export interface FilterPublicMultiaddrsOptions {
  browserDialableOnly?: boolean;
  requirePeerId?: boolean;
}

export interface CreateRelayBootstrapPostOptions {
  sender: string;
  peerId: string;
  multiaddrs: string[];
  browserMultiaddrs?: string[];
  registrationId?: string;
  ref?: string;
  channel?: string;
  profile?: string;
  version?: string;
  ownerAddress?: string;
  publisherAddress?: string;
  authorization?: RelayBootstrapAuthorizationRecord;
  relayProof?: RelayBootstrapProofRecord;
  compactMultiaddrLimit?: number;
  now?: number;
  hasher: (payload: string) => Promise<string> | string;
}

export type RelayBootstrapTrustMode = "wallet-signed" | "dual-key-attested";

function serializeOwnerAuthorizationPayload(
  payload: RelayBootstrapAuthorizationPayload,
): string {
  return JSON.stringify({
    ownerAddress: payload.ownerAddress,
    publisherAddress: payload.publisherAddress,
    peerId: payload.peerId,
    registrationId: payload.registrationId,
    profile: payload.profile,
    version: payload.version,
    instanceItemHash: payload.instanceItemHash,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
  });
}

function serializeRelayProofPayload(
  payload: RelayBootstrapProofPayload,
): string {
  return JSON.stringify({
    peerId: payload.peerId,
    multiaddrs: payload.multiaddrs
      ? dedupeMultiaddrs(payload.multiaddrs)
      : undefined,
    browserMultiaddrs: payload.browserMultiaddrs
      ? dedupeMultiaddrs(payload.browserMultiaddrs)
      : undefined,
    multiaddrsHash: payload.multiaddrsHash,
    browserMultiaddrsHash: payload.browserMultiaddrsHash,
    registrationId: payload.registrationId,
    profile: payload.profile,
    version: payload.version,
    updatedAt: payload.updatedAt,
  });
}

export function relayBootstrapMultiaddrsHash(addrs: readonly string[]): string {
  return keccak256(stringToHex(JSON.stringify(dedupeMultiaddrs(addrs))));
}

function browserMultiaddrPreference(addr: string): number {
  const normalized = addr.toLowerCase();
  if (normalized.includes("/tcp/443/tls/ws/")) return 0;
  if (normalized.includes("/tls/ws/")) return 1;
  if (normalized.includes("/webtransport/")) return 2;
  if (normalized.includes("/webrtc-direct/")) return 3;
  if (normalized.includes("/ws")) return 4;
  return 5;
}

function browserMultiaddrTransport(addr: string): string {
  const normalized = addr.toLowerCase();
  if (normalized.includes("/webtransport/")) return "webtransport";
  if (normalized.includes("/webrtc-direct/")) return "webrtc";
  if (normalized.includes("/ws") || normalized.includes("/wss"))
    return "websocket";
  return "other";
}

export function selectCompactRelayBootstrapMultiaddrs(
  addrs: readonly string[],
  limit = DEFAULT_BOOTSTRAP_COMPACT_MULTIADDR_LIMIT,
): string[] {
  const entries = filterPublicMultiaddrs(addrs, {
    browserDialableOnly: true,
  }).map((addr, index) => ({
    addr,
    index,
    transport: browserMultiaddrTransport(addr),
  }));

  entries.sort((left, right) => {
    const preference =
      browserMultiaddrPreference(left.addr) -
      browserMultiaddrPreference(right.addr);
    return preference !== 0 ? preference : left.index - right.index;
  });

  const perTransportLimit = Math.max(1, Math.floor(limit));
  const selectedByTransport = new Map<string, number>();
  const result: string[] = [];

  for (const entry of entries) {
    const selected = selectedByTransport.get(entry.transport) ?? 0;
    if (selected >= perTransportLimit) continue;

    selectedByTransport.set(entry.transport, selected + 1);
    result.push(entry.addr);
  }

  return result;
}

async function recoverAddressForSignature(
  payload: string,
  signature: string,
): Promise<string> {
  return recoverMessageAddress({
    message: payload,
    signature: signature as `0x${string}`,
  });
}

type AlephPostsResponse = {
  posts?: unknown[];
};

function asTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase();
}

function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

function normalizeSignature(signature: string): string {
  const trimmed = signature.trim();
  return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
}

function splitMultiaddr(addr: string): string[] {
  return addr.split("/").filter(Boolean);
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }

  if (parts[0] === 10) return true;
  if (parts[0] === 127) return true;
  if (parts[0] === 0) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;

  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const normalized = ip.trim().toLowerCase();
  return (
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  );
}

function isLocalHostname(host: string): boolean {
  const normalized = normalizeHost(host);
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local")
  );
}

function hasPeerId(addr: string): boolean {
  return splitMultiaddr(addr).includes("p2p");
}

function isBrowserDialableMultiaddr(addr: string): boolean {
  const normalized = addr.toLowerCase();
  if (
    normalized.includes("/webtransport") ||
    normalized.includes("/webrtc-direct")
  ) {
    return normalized.includes("/certhash/");
  }
  return normalized.includes("/ws") || normalized.includes("/wss");
}

export function dedupeMultiaddrs(addrs: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of addrs) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }

  return result;
}

export function isPublicMultiaddr(addr: string): boolean {
  const parts = splitMultiaddr(addr);
  for (let index = 0; index < parts.length; index += 1) {
    const protocol = parts[index];
    const value = parts[index + 1];

    if (protocol === "ip4" && value) {
      return !isPrivateIpv4(value);
    }
    if (protocol === "ip6" && value) {
      return !isPrivateIpv6(value);
    }
    if (
      (protocol === "dns4" || protocol === "dns6" || protocol === "dnsaddr") &&
      value
    ) {
      return !isLocalHostname(value);
    }
  }

  return false;
}

export function filterPublicMultiaddrs(
  addrs: readonly string[],
  options: FilterPublicMultiaddrsOptions = {},
): string[] {
  return dedupeMultiaddrs(addrs).filter((addr) => {
    if (!isPublicMultiaddr(addr)) return false;
    if (options.requirePeerId !== false && !hasPeerId(addr)) return false;
    if (options.browserDialableOnly && !isBrowserDialableMultiaddr(addr)) {
      return false;
    }
    return true;
  });
}

function normalizeRelayBootstrapContent(
  value: unknown,
): RelayBootstrapContent | null {
  if (!value || typeof value !== "object") return null;
  const content = value as Record<string, unknown>;
  const peerId = asTrimmedString(content.peerId);
  const updatedAt = asNumber(content.updatedAt);
  if (!peerId || updatedAt == null) return null;

  const multiaddrs = Array.isArray(content.multiaddrs)
    ? content.multiaddrs.filter(
        (entry): entry is string => typeof entry === "string",
      )
    : [];
  const browserMultiaddrs = Array.isArray(content.browserMultiaddrs)
    ? content.browserMultiaddrs.filter(
        (entry): entry is string => typeof entry === "string",
      )
    : undefined;

  return {
    peerId,
    multiaddrs: dedupeMultiaddrs(multiaddrs),
    browserMultiaddrs: browserMultiaddrs
      ? dedupeMultiaddrs(browserMultiaddrs)
      : undefined,
    registrationId: asTrimmedString(content.registrationId) ?? undefined,
    profile: asTrimmedString(content.profile) ?? undefined,
    version: asTrimmedString(content.version) ?? undefined,
    ownerAddress: asTrimmedString(content.ownerAddress) ?? undefined,
    publisherAddress: asTrimmedString(content.publisherAddress) ?? undefined,
    authorization:
      normalizeRelayBootstrapAuthorizationRecord(content.authorization) ??
      undefined,
    relayProof:
      normalizeRelayBootstrapProofRecord(content.relayProof) ?? undefined,
    updatedAt,
  };
}

function normalizeRelayBootstrapAuthorizationPayload(
  value: unknown,
): RelayBootstrapAuthorizationPayload | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as Record<string, unknown>;
  const ownerAddress = asTrimmedString(payload.ownerAddress);
  const publisherAddress = asTrimmedString(payload.publisherAddress);
  const peerId = asTrimmedString(payload.peerId);
  const issuedAt = asNumber(payload.issuedAt);
  const expiresAt = asNumber(payload.expiresAt) ?? undefined;
  if (!ownerAddress || !publisherAddress || !peerId || issuedAt == null) {
    return null;
  }

  return {
    ownerAddress,
    publisherAddress,
    peerId,
    registrationId: asTrimmedString(payload.registrationId) ?? undefined,
    profile: asTrimmedString(payload.profile) ?? undefined,
    version: asTrimmedString(payload.version) ?? undefined,
    instanceItemHash: asTrimmedString(payload.instanceItemHash) ?? undefined,
    issuedAt,
    expiresAt,
  };
}

function normalizeRelayBootstrapAuthorizationRecord(
  value: unknown,
): RelayBootstrapAuthorizationRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const scheme = asTrimmedString(record.scheme);
  const signature = asTrimmedString(record.signature);
  const payload = normalizeRelayBootstrapAuthorizationPayload(record.payload);
  if (!scheme || !signature || !payload) return null;
  return { scheme, signature, payload };
}

function normalizeRelayBootstrapProofPayload(
  value: unknown,
): RelayBootstrapProofPayload | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as Record<string, unknown>;
  const peerId = asTrimmedString(payload.peerId);
  const updatedAt = asNumber(payload.updatedAt);
  if (!peerId || updatedAt == null) return null;
  const multiaddrs = Array.isArray(payload.multiaddrs)
    ? payload.multiaddrs.filter(
        (entry): entry is string => typeof entry === "string",
      )
    : [];
  const browserMultiaddrs = Array.isArray(payload.browserMultiaddrs)
    ? payload.browserMultiaddrs.filter(
        (entry): entry is string => typeof entry === "string",
      )
    : undefined;

  return {
    peerId,
    multiaddrs:
      multiaddrs.length > 0 ? dedupeMultiaddrs(multiaddrs) : undefined,
    browserMultiaddrs: browserMultiaddrs
      ? dedupeMultiaddrs(browserMultiaddrs)
      : undefined,
    multiaddrsHash: asTrimmedString(payload.multiaddrsHash) ?? undefined,
    browserMultiaddrsHash:
      asTrimmedString(payload.browserMultiaddrsHash) ?? undefined,
    registrationId: asTrimmedString(payload.registrationId) ?? undefined,
    profile: asTrimmedString(payload.profile) ?? undefined,
    version: asTrimmedString(payload.version) ?? undefined,
    updatedAt,
  };
}

function normalizeRelayBootstrapProofRecord(
  value: unknown,
): RelayBootstrapProofRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const scheme = asTrimmedString(record.scheme);
  const signature = asTrimmedString(record.signature);
  const payload = normalizeRelayBootstrapProofPayload(record.payload);
  if (!scheme || !signature || !payload) return null;
  return { scheme, signature, payload };
}

function normalizeRelayBootstrapPostRecord(
  value: unknown,
): RelayBootstrapPostRecord | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  return {
    hash: asTrimmedString(entry.hash),
    itemHash: asTrimmedString(entry.item_hash),
    address: asTrimmedString(entry.address),
    ref: asTrimmedString(entry.ref),
    type: asTrimmedString(entry.type),
    time: asNumber(entry.time),
    content: normalizeRelayBootstrapContent(entry.content),
  };
}

export function buildRelayBootstrapPostContent(args: {
  sender: string;
  peerId: string;
  multiaddrs: string[];
  browserMultiaddrs?: string[];
  registrationId?: string;
  ref?: string;
  profile?: string;
  version?: string;
  ownerAddress?: string;
  publisherAddress?: string;
  authorization?: RelayBootstrapAuthorizationRecord;
  relayProof?: RelayBootstrapProofRecord;
  compactMultiaddrLimit?: number;
  now?: number;
}): RelayBootstrapPostContent {
  const now = args.now ?? Date.now() / 1000;
  const updatedAt = args.now ?? Date.now();
  const fullMultiaddrs = filterPublicMultiaddrs(args.multiaddrs);
  const fullBrowserMultiaddrs = args.browserMultiaddrs
    ? filterPublicMultiaddrs(args.browserMultiaddrs, {
        browserDialableOnly: true,
      })
    : undefined;
  const compactMultiaddrs = selectCompactRelayBootstrapMultiaddrs(
    fullBrowserMultiaddrs && fullBrowserMultiaddrs.length > 0
      ? fullBrowserMultiaddrs
      : fullMultiaddrs,
    args.compactMultiaddrLimit,
  );

  return {
    type: DEFAULT_ALEPH_BOOTSTRAP_POST_TYPE,
    address: args.sender,
    ...(args.ref ? { ref: args.ref } : {}),
    content: {
      peerId: args.peerId,
      multiaddrs: compactMultiaddrs,
      browserMultiaddrs: undefined,
      registrationId: args.registrationId,
      profile: args.profile,
      version: args.version,
      ownerAddress: args.ownerAddress,
      publisherAddress: args.publisherAddress,
      authorization: args.authorization,
      relayProof: args.relayProof,
      updatedAt: Math.round(updatedAt),
    },
    time: now,
  };
}

export async function createRelayBootstrapPost(
  args: CreateRelayBootstrapPostOptions,
): Promise<{
  channel: string;
  sender: string;
  chain: "ETH";
  type: "POST";
  time: number;
  item_type: "inline";
  item_content: string;
  item_hash: string;
}> {
  const nowMillis = args.now ?? Date.now();
  const nowSeconds = nowMillis / 1000;
  const itemContent = buildRelayBootstrapPostContent({
    sender: args.sender,
    peerId: args.peerId,
    multiaddrs: args.multiaddrs,
    browserMultiaddrs: args.browserMultiaddrs,
    registrationId: args.registrationId,
    ref: args.ref ?? DEFAULT_ALEPH_BOOTSTRAP_REF,
    profile: args.profile,
    version: args.version,
    ownerAddress: args.ownerAddress,
    publisherAddress: args.publisherAddress,
    authorization: args.authorization,
    relayProof: args.relayProof,
    compactMultiaddrLimit: args.compactMultiaddrLimit,
    now: nowMillis,
  });
  itemContent.time = nowSeconds;
  const serialized = JSON.stringify(itemContent);
  const itemHash = await args.hasher(serialized);

  return {
    channel: args.channel ?? DEFAULT_ALEPH_BOOTSTRAP_CHANNEL,
    sender: args.sender,
    chain: "ETH",
    type: "POST",
    time: nowSeconds,
    item_type: "inline",
    item_content: serialized,
    item_hash: itemHash,
  };
}

export function relayBootstrapTrustMode(
  content: RelayBootstrapContent | null | undefined,
): RelayBootstrapTrustMode {
  if (
    content?.authorization &&
    content?.relayProof &&
    content.authorization.payload.publisherAddress &&
    content.relayProof.payload.peerId
  ) {
    return "dual-key-attested";
  }
  return "wallet-signed";
}

export async function signRelayBootstrapAuthorization(args: {
  ownerAddress: string;
  publisherAddress: string;
  peerId: string;
  registrationId?: string;
  profile?: string;
  version?: string;
  instanceItemHash?: string;
  issuedAt?: number;
  expiresAt?: number;
  signer: RelayBootstrapProofSigner;
}): Promise<RelayBootstrapAuthorizationRecord> {
  const payload: RelayBootstrapAuthorizationPayload = {
    ownerAddress: args.ownerAddress,
    publisherAddress: args.publisherAddress,
    peerId: args.peerId,
    registrationId: args.registrationId,
    profile: args.profile,
    version: args.version,
    instanceItemHash: args.instanceItemHash,
    issuedAt: args.issuedAt ?? Date.now(),
    expiresAt: args.expiresAt,
  };
  const serialized = serializeOwnerAuthorizationPayload(payload);
  const signature = await args.signer(args.ownerAddress, serialized);

  return {
    scheme: RELAY_BOOTSTRAP_SIGNATURE_SCHEME,
    payload,
    signature: normalizeSignature(signature),
  };
}

export async function signRelayBootstrapProof(args: {
  publisherAddress: string;
  peerId: string;
  multiaddrs: string[];
  browserMultiaddrs?: string[];
  registrationId?: string;
  profile?: string;
  version?: string;
  updatedAt?: number;
  compactMultiaddrLimit?: number;
  signer: RelayBootstrapProofSigner;
}): Promise<RelayBootstrapProofRecord> {
  const fullMultiaddrs = filterPublicMultiaddrs(args.multiaddrs);
  const fullBrowserMultiaddrs = args.browserMultiaddrs
    ? filterPublicMultiaddrs(args.browserMultiaddrs, {
        browserDialableOnly: true,
      })
    : undefined;
  const compactMultiaddrs = selectCompactRelayBootstrapMultiaddrs(
    fullBrowserMultiaddrs && fullBrowserMultiaddrs.length > 0
      ? fullBrowserMultiaddrs
      : fullMultiaddrs,
    args.compactMultiaddrLimit,
  );
  const payload: RelayBootstrapProofPayload = {
    peerId: args.peerId,
    multiaddrs: undefined,
    browserMultiaddrs: undefined,
    multiaddrsHash: relayBootstrapMultiaddrsHash(compactMultiaddrs),
    registrationId: args.registrationId,
    profile: args.profile,
    version: args.version,
    updatedAt: args.updatedAt ?? Date.now(),
  };
  const serialized = serializeRelayProofPayload(payload);
  const signature = await args.signer(args.publisherAddress, serialized);

  return {
    scheme: RELAY_BOOTSTRAP_SIGNATURE_SCHEME,
    payload,
    signature: normalizeSignature(signature),
  };
}

export async function verifyRelayBootstrapAuthorization(
  authorization: RelayBootstrapAuthorizationRecord | null | undefined,
  options: { now?: number } = {},
): Promise<RelayBootstrapVerificationResult> {
  const errors: string[] = [];
  if (!authorization) {
    errors.push("Missing owner authorization.");
    return { ok: false, errors };
  }

  if (authorization.scheme !== RELAY_BOOTSTRAP_SIGNATURE_SCHEME) {
    errors.push(
      `Unsupported owner authorization scheme: ${authorization.scheme}`,
    );
    return { ok: false, errors };
  }

  const payload = authorization.payload;
  const serialized = serializeOwnerAuthorizationPayload(payload);
  try {
    const recovered = await recoverAddressForSignature(
      serialized,
      authorization.signature,
    );
    if (
      normalizeAddress(recovered) !== normalizeAddress(payload.ownerAddress)
    ) {
      errors.push(
        "Owner authorization signature does not recover the owner address.",
      );
    }
  } catch (error) {
    errors.push(
      `Owner authorization signature could not be recovered: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const now = options.now ?? Date.now();
  if (payload.expiresAt != null && now > payload.expiresAt) {
    errors.push("Owner authorization has expired.");
  }

  return { ok: errors.length === 0, errors };
}

export async function verifyRelayBootstrapProof(
  proof: RelayBootstrapProofRecord | null | undefined,
  options: {
    expectedPublisherAddress?: string;
    expectedPeerId?: string;
  } = {},
): Promise<RelayBootstrapVerificationResult> {
  const errors: string[] = [];
  if (!proof) {
    errors.push("Missing relay proof.");
    return { ok: false, errors };
  }

  if (proof.scheme !== RELAY_BOOTSTRAP_SIGNATURE_SCHEME) {
    errors.push(`Unsupported relay proof scheme: ${proof.scheme}`);
    return { ok: false, errors };
  }

  const payload = proof.payload;
  const serialized = serializeRelayProofPayload(payload);
  try {
    const recovered = await recoverAddressForSignature(
      serialized,
      proof.signature,
    );

    if (
      options.expectedPublisherAddress &&
      normalizeAddress(recovered) !==
        normalizeAddress(options.expectedPublisherAddress)
    ) {
      errors.push(
        "Relay proof signature does not recover the expected publisher address.",
      );
    }
  } catch (error) {
    errors.push(
      `Relay proof signature could not be recovered: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (options.expectedPeerId && payload.peerId !== options.expectedPeerId) {
    errors.push("Relay proof peer ID does not match the expected peer ID.");
  }

  return { ok: errors.length === 0, errors };
}

export async function verifyRelayBootstrapDualKeyContent(
  content: RelayBootstrapContent | null | undefined,
  options: { now?: number } = {},
): Promise<RelayBootstrapVerificationResult> {
  const errors: string[] = [];
  if (!content) {
    errors.push("Missing relay bootstrap content.");
    return { ok: false, errors };
  }

  const authorization = await verifyRelayBootstrapAuthorization(
    content.authorization,
    options,
  );
  errors.push(...authorization.errors);

  const expectedPublisherAddress =
    content.publisherAddress ??
    content.authorization?.payload.publisherAddress ??
    undefined;
  const proof = await verifyRelayBootstrapProof(content.relayProof, {
    expectedPublisherAddress,
    expectedPeerId: content.peerId,
  });
  errors.push(...proof.errors);

  if (content.ownerAddress && content.authorization) {
    if (
      normalizeAddress(content.ownerAddress) !==
      normalizeAddress(content.authorization.payload.ownerAddress)
    ) {
      errors.push(
        "Content ownerAddress does not match the owner authorization payload.",
      );
    }
  }

  if (expectedPublisherAddress && content.authorization) {
    if (
      normalizeAddress(expectedPublisherAddress) !==
      normalizeAddress(content.authorization.payload.publisherAddress)
    ) {
      errors.push(
        "Content publisherAddress does not match the owner authorization payload.",
      );
    }
  }

  if (
    content.authorization &&
    content.authorization.payload.peerId !== content.peerId
  ) {
    errors.push(
      "Owner authorization peer ID does not match the bootstrap content peer ID.",
    );
  }

  const proofPayload = content.relayProof?.payload;
  if (proofPayload) {
    if (proofPayload.registrationId !== content.registrationId) {
      errors.push(
        "Relay proof registrationId does not match the bootstrap content.",
      );
    }
    if (proofPayload.profile !== content.profile) {
      errors.push("Relay proof profile does not match the bootstrap content.");
    }
    if (proofPayload.version !== content.version) {
      errors.push("Relay proof version does not match the bootstrap content.");
    }
    if (proofPayload.updatedAt !== content.updatedAt) {
      errors.push(
        "Relay proof updatedAt does not match the bootstrap content.",
      );
    }
    if (proofPayload.multiaddrsHash) {
      if (
        proofPayload.multiaddrsHash !==
        relayBootstrapMultiaddrsHash(content.multiaddrs)
      ) {
        errors.push(
          "Relay proof multiaddrs hash does not match the bootstrap content.",
        );
      }
    } else if (
      JSON.stringify(dedupeMultiaddrs(proofPayload.multiaddrs ?? [])) !==
      JSON.stringify(dedupeMultiaddrs(content.multiaddrs))
    ) {
      errors.push("Relay proof multiaddrs do not match the bootstrap content.");
    }
    if (proofPayload.browserMultiaddrsHash) {
      if (
        proofPayload.browserMultiaddrsHash !==
        relayBootstrapMultiaddrsHash(content.browserMultiaddrs ?? [])
      ) {
        errors.push(
          "Relay proof browserMultiaddrs hash does not match the bootstrap content.",
        );
      }
    } else if (proofPayload.browserMultiaddrs || content.browserMultiaddrs) {
      if (
        JSON.stringify(
          dedupeMultiaddrs(proofPayload.browserMultiaddrs ?? []),
        ) !== JSON.stringify(dedupeMultiaddrs(content.browserMultiaddrs ?? []))
      ) {
        errors.push(
          "Relay proof browserMultiaddrs do not match the bootstrap content.",
        );
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

export async function fetchAlephBootstrapPosts(
  options: DiscoverAlephBootstrapOptions = {},
): Promise<RelayBootstrapPostRecord[]> {
  const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
  if (typeof fetchImpl !== "function") {
    throw new Error(
      "A fetch implementation is required to query Aleph bootstrap posts.",
    );
  }

  const url = new URL(
    "/api/v0/posts.json",
    options.apiHost ?? DEFAULT_ALEPH_API_HOST,
  );
  url.searchParams.set(
    "channels",
    options.channel ?? DEFAULT_ALEPH_BOOTSTRAP_CHANNEL,
  );
  url.searchParams.set("refs", options.ref ?? DEFAULT_ALEPH_BOOTSTRAP_REF);
  url.searchParams.set("types", DEFAULT_ALEPH_BOOTSTRAP_POST_TYPE);
  url.searchParams.set(
    "pagination",
    String(options.pagination ?? DEFAULT_BOOTSTRAP_PAGINATION),
  );
  url.searchParams.set("page", String(options.page ?? 1));

  const response = await fetchImpl(url.toString(), {
    method: "GET",
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Aleph bootstrap post lookup failed: ${response.status}`);
  }

  const payload = (await response.json()) as AlephPostsResponse;
  const posts = (payload.posts ?? [])
    .map((entry) => normalizeRelayBootstrapPostRecord(entry))
    .filter((entry): entry is RelayBootstrapPostRecord => entry != null)
    .sort((left, right) => compareRelayBootstrapPostRecency(right, left));

  posts.forEach(assertSupportedRelayBootstrapPost);
  return posts;
}

function assertSupportedRelayBootstrapPost(
  post: RelayBootstrapPostRecord,
): void {
  if (post.type === "relay-bootstrap") {
    throw new Error(
      "Legacy relay-bootstrap record encountered. Only relay-bootstrap-v2 is supported.",
    );
  }
  if (post.type && post.type !== DEFAULT_ALEPH_BOOTSTRAP_POST_TYPE) {
    throw new Error(
      `Unsupported relay bootstrap post type: ${post.type}. Expected ${DEFAULT_ALEPH_BOOTSTRAP_POST_TYPE}.`,
    );
  }
}

function compareRelayBootstrapPostRecency(
  left: RelayBootstrapPostRecord,
  right: RelayBootstrapPostRecord,
): number {
  const leftUpdatedAt = left.content?.updatedAt ?? 0;
  const rightUpdatedAt = right.content?.updatedAt ?? 0;
  if (leftUpdatedAt !== rightUpdatedAt) return leftUpdatedAt - rightUpdatedAt;

  const leftTime = left.time ?? 0;
  const rightTime = right.time ?? 0;
  return leftTime - rightTime;
}

function relayBootstrapRecordIdentity(
  post: RelayBootstrapPostRecord,
): string | null {
  const content = post.content;
  if (!content) return null;
  if (content.registrationId) return `registration:${content.registrationId}`;
  if (post.address) return `sender:${normalizeAddress(post.address)}`;
  return content.peerId ? `peer:${content.peerId}` : null;
}

export function selectCurrentRelayBootstrapPosts(
  posts: readonly RelayBootstrapPostRecord[],
  options: Pick<DiscoverAlephBootstrapOptions, "maxAgeMs"> & {
    now?: number;
  } = {},
): RelayBootstrapPostRecord[] {
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_BOOTSTRAP_MAX_AGE_MS;
  const now = options.now ?? Date.now();
  const selected = new Map<string, RelayBootstrapPostRecord>();

  for (const post of posts) {
    assertSupportedRelayBootstrapPost(post);
    const content = post.content;
    if (!content) continue;
    if (now - content.updatedAt > maxAgeMs) continue;

    const identity = relayBootstrapRecordIdentity(post);
    if (!identity) continue;

    const previous = selected.get(identity);
    if (!previous || compareRelayBootstrapPostRecency(post, previous) > 0) {
      selected.set(identity, post);
    }
  }

  return [...selected.values()].sort((left, right) =>
    compareRelayBootstrapPostRecency(right, left),
  );
}

/**
 * Keep only posts whose registration profile matches the requested profile(s).
 * A missing/empty filter is a no-op so existing callers are unaffected.
 */
export function filterRelayBootstrapPostsByProfile(
  posts: readonly RelayBootstrapPostRecord[],
  profile?: string | readonly string[],
): RelayBootstrapPostRecord[] {
  const wanted = (typeof profile === "string" ? [profile] : (profile ?? []))
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (wanted.length === 0) return [...posts];
  const allowed = new Set(wanted);
  return posts.filter(
    (post) => post.content != null && allowed.has(String(post.content.profile)),
  );
}

async function filterTrustedRelayBootstrapPosts(
  posts: readonly RelayBootstrapPostRecord[],
  options: Pick<
    DiscoverAlephBootstrapOptions,
    "requireDualKeyAttestation" | "verifyDualKeyAttestation"
  > = {},
): Promise<RelayBootstrapPostRecord[]> {
  const requireDualKeyAttestation = options.requireDualKeyAttestation ?? false;
  const verifyDualKeyAttestation = options.verifyDualKeyAttestation ?? true;
  const trusted: RelayBootstrapPostRecord[] = [];

  for (const post of posts) {
    const content = post.content;
    if (!content) continue;

    const trustMode = relayBootstrapTrustMode(content);
    if (trustMode === "wallet-signed") {
      if (!requireDualKeyAttestation) {
        trusted.push(post);
      }
      continue;
    }

    if (!verifyDualKeyAttestation) {
      trusted.push(post);
      continue;
    }

    const verification = await verifyRelayBootstrapDualKeyContent(content);
    if (verification.ok) {
      trusted.push(post);
    }
  }

  return trusted;
}

export async function discoverAlephBootstrapMultiaddrs(
  options: DiscoverAlephBootstrapOptions = {},
): Promise<string[]> {
  const browserDialableOnly = options.browserDialableOnly ?? true;
  const pagination = options.pagination ?? DEFAULT_BOOTSTRAP_PAGINATION;
  const startPage = options.page ?? 1;
  const maxPages = Math.max(1, options.maxPages ?? DEFAULT_BOOTSTRAP_MAX_PAGES);
  const collectedPosts: RelayBootstrapPostRecord[] = [];

  for (let offset = 0; offset < maxPages; offset += 1) {
    const page = startPage + offset;
    const pagePosts = await fetchAlephBootstrapPosts({
      ...options,
      page,
      pagination,
    });
    collectedPosts.push(...pagePosts);

    const selectedPosts = filterRelayBootstrapPostsByProfile(
      selectCurrentRelayBootstrapPosts(collectedPosts, {
        maxAgeMs: options.maxAgeMs,
      }),
      options.profile,
    );
    const trustedPosts = await filterTrustedRelayBootstrapPosts(selectedPosts, {
      requireDualKeyAttestation: options.requireDualKeyAttestation,
      verifyDualKeyAttestation: options.verifyDualKeyAttestation,
    });
    const addrs = relayBootstrapPostsToMultiaddrs(
      trustedPosts,
      browserDialableOnly,
    );
    if (addrs.length > 0) {
      return addrs;
    }

    if (pagePosts.length < pagination) {
      break;
    }
  }

  return [];
}

function relayBootstrapPostsToMultiaddrs(
  posts: readonly RelayBootstrapPostRecord[],
  browserDialableOnly: boolean,
): string[] {
  const addrs: string[] = [];

  for (const post of posts) {
    const content = post.content;
    if (!content) continue;

    const candidates =
      browserDialableOnly &&
      Array.isArray(content.browserMultiaddrs) &&
      content.browserMultiaddrs.length > 0
        ? content.browserMultiaddrs
        : content.multiaddrs;

    addrs.push(
      ...filterPublicMultiaddrs(candidates, {
        browserDialableOnly,
      }),
    );
  }

  return dedupeMultiaddrs(addrs);
}

export async function createLibp2pAlephBootstrap(
  options: DiscoverAlephBootstrapOptions & {
    timeout?: number;
    tagName?: string;
  } = {},
): Promise<ReturnType<typeof bootstrap>> {
  const list = await discoverAlephBootstrapMultiaddrs(options);
  return bootstrap({
    list,
    timeout: options.timeout,
    tagName: options.tagName,
  });
}
