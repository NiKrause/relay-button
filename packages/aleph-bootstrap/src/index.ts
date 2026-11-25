import { bootstrap } from "@libp2p/bootstrap";
import { keccak256, recoverMessageAddress, stringToHex } from "viem";
import { peerIdFromString } from "@libp2p/peer-id";
import { multiaddr } from "@multiformats/multiaddr";

export const DEFAULT_ALEPH_API_HOST = "https://api.aleph.im";
export const DEFAULT_ALEPH_BOOTSTRAP_CHANNEL = "simple-todo";
export const DEFAULT_ALEPH_BOOTSTRAP_REF = "simple-todo-bootstrap";
export const DEFAULT_ALEPH_BOOTSTRAP_POST_TYPE = "relay-bootstrap-v2";
export const DEFAULT_BOOTSTRAP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_BOOTSTRAP_PAGINATION = 50;
export const DEFAULT_BOOTSTRAP_MAX_PAGES = 5;
export const DEFAULT_BOOTSTRAP_COMPACT_MULTIADDR_LIMIT = 3;
export const RELAY_BOOTSTRAP_SIGNATURE_SCHEME = "personal_sign";

/**
 * An optional field of a signed payload, as it was recorded.
 *
 * `null` and "left out" mean the same thing to a reader, but they are two
 * different signed texts: `{"version":null}` is not `{}`. The guest refresh
 * scripts sign with Python's `json.dumps`, which writes an unset field as
 * `null`; the helpers in this file sign with `JSON.stringify`, which leaves an
 * `undefined` one out. A reader has to hand back whichever it was given, or
 * the signature recovers somebody else's address.
 */
export type SignedOptional<T> = T | null | undefined;

export interface RelayBootstrapAuthorizationPayload {
  ownerAddress: string;
  publisherAddress: string;
  peerId: string;
  registrationId?: SignedOptional<string>;
  profile?: SignedOptional<string>;
  version?: SignedOptional<string>;
  instanceItemHash?: SignedOptional<string>;
  issuedAt: number;
  expiresAt?: SignedOptional<number>;
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
  multiaddrsHash?: SignedOptional<string>;
  browserMultiaddrsHash?: SignedOptional<string>;
  registrationId?: SignedOptional<string>;
  profile?: SignedOptional<string>;
  version?: SignedOptional<string>;
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
  /**
   * Keep plaintext `/ws` relays in a browser-dialable result. Defaults to
   * false so an https page never receives an address the browser will block as
   * mixed content. Set it for consumers that dial from node or a plain-http
   * origin.
   */
  allowInsecureWebSockets?: boolean;
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
  /**
   * Restrict discovery further, to the registrations published under this id
   * (e.g. `"relay:orbitdb-relay:orbitdb-relay"`). Profile is not fine enough:
   * an E2E run's throwaway relays register under the same profile as the
   * production one, and a registration outlives the machine it describes. Use
   * this for anything that bakes addresses into a build or dials them on
   * start; omit it to see the whole channel.
   */
  registrationId?: string | readonly string[];
  /**
   * Called for each record discovery had to skip. Optional, and the default of
   * doing nothing is deliberate — a skipped record is not an error for the
   * consumer — but a consumer whose relay went missing wants to see this.
   */
  onUnsupportedPost?: (skipped: { hash: string | null | undefined; reason: string }) => void;
  fetch?: typeof fetch;
}

export interface FilterPublicMultiaddrsOptions {
  browserDialableOnly?: boolean;
  requirePeerId?: boolean;
  /**
   * Keep plaintext `/ws` addresses in the browser-dialable set. Defaults to
   * false: a page served over https cannot open a `ws://` socket, the browser
   * blocks it as mixed content, so a plaintext relay is dead weight in a
   * browser bootstrap list. Publishers pass true — a relay should still
   * announce the plaintext port it really serves, for node peers that can use
   * it.
   */
  allowInsecureWebSockets?: boolean;
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

/**
 * The exact text the owner signed. Key order is fixed here because the
 * registry does not keep it; `null` versus "left out" is taken from the
 * payload, because `JSON.stringify` writes the first and drops the second.
 */
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

/** The exact text the publisher signed; see the owner serializer above. */
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

/**
 * Publish-side helper: pick the addresses a relay announces to the registry.
 * Plaintext `/ws` is kept here on purpose — announcing the port the relay
 * really serves is honest, and node peers can dial it. Browsers filter it out
 * again on the read side, where the https origin makes it undialable.
 */
export function selectCompactRelayBootstrapMultiaddrs(
  addrs: readonly string[],
  limit = DEFAULT_BOOTSTRAP_COMPACT_MULTIADDR_LIMIT,
): string[] {
  const entries = filterPublicMultiaddrs(addrs, {
    browserDialableOnly: true,
    allowInsecureWebSockets: true,
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

/**
 * Read an optional field of a signed payload without changing what was signed.
 *
 * Folding a recorded `null` into `undefined` looked harmless and made every
 * registration the guest refresh scripts publish unverifiable: they sign
 * `"version":null`, the reader rebuilt the text without the field, and the
 * proof recovered a different address. Measured on 2026-11-20, when discovery
 * returned one production relay of three for exactly this reason.
 */
function asSignedOptionalString(value: unknown): SignedOptional<string> {
  if (value === null) return null;
  return asTrimmedString(value) ?? undefined;
}

function asSignedOptionalNumber(value: unknown): SignedOptional<number> {
  if (value === null) return null;
  return asNumber(value) ?? undefined;
}

/** `null` and "left out" are one value once the signature has been checked. */
function sameOptional(left: unknown, right: unknown): boolean {
  return (left ?? undefined) === (right ?? undefined);
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

/**
 * Whether a WebSocket multiaddr terminates TLS, i.e. whether it maps to a
 * `wss://` URL rather than a `ws://` one. `/wss` is the legacy spelling of
 * `/tls/ws`; `/tls/sni/<host>/ws` is the form the relay announces when Caddy
 * fronts it. A bare `/ws` is plaintext.
 */
function isSecureWebSocketMultiaddr(addr: string): boolean {
  const parts = splitMultiaddr(addr.toLowerCase());
  if (parts.includes("wss")) return true;
  const wsIndex = parts.indexOf("ws");
  return wsIndex > 0 && parts.lastIndexOf("tls", wsIndex) >= 0;
}

function isWebSocketMultiaddr(addr: string): boolean {
  const parts = splitMultiaddr(addr.toLowerCase());
  return parts.includes("ws") || parts.includes("wss");
}

export function isBrowserDialableMultiaddr(
  addr: string,
  options: Pick<FilterPublicMultiaddrsOptions, "allowInsecureWebSockets"> = {},
): boolean {
  const normalized = addr.toLowerCase();
  if (
    normalized.includes("/webtransport") ||
    normalized.includes("/webrtc-direct")
  ) {
    return normalized.includes("/certhash/");
  }
  if (!isWebSocketMultiaddr(addr)) return false;
  return (
    (options.allowInsecureWebSockets ?? false) ||
    isSecureWebSocketMultiaddr(addr)
  );
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
    if (
      options.browserDialableOnly &&
      !isBrowserDialableMultiaddr(addr, {
        allowInsecureWebSockets: options.allowInsecureWebSockets,
      })
    ) {
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
  const expiresAt = asSignedOptionalNumber(payload.expiresAt);
  if (!ownerAddress || !publisherAddress || !peerId || issuedAt == null) {
    return null;
  }

  return {
    ownerAddress,
    publisherAddress,
    peerId,
    registrationId: asSignedOptionalString(payload.registrationId),
    profile: asSignedOptionalString(payload.profile),
    version: asSignedOptionalString(payload.version),
    instanceItemHash: asSignedOptionalString(payload.instanceItemHash),
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
    multiaddrsHash: asSignedOptionalString(payload.multiaddrsHash),
    browserMultiaddrsHash: asSignedOptionalString(
      payload.browserMultiaddrsHash,
    ),
    registrationId: asSignedOptionalString(payload.registrationId),
    profile: asSignedOptionalString(payload.profile),
    version: asSignedOptionalString(payload.version),
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
        allowInsecureWebSockets: true,
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
        allowInsecureWebSockets: true,
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
    // The content is not part of the signed text, so its own `null`s are
    // still folded away on read; compare by meaning, not by spelling.
    if (!sameOptional(proofPayload.registrationId, content.registrationId)) {
      errors.push(
        "Relay proof registrationId does not match the bootstrap content.",
      );
    }
    if (!sameOptional(proofPayload.profile, content.profile)) {
      errors.push("Relay proof profile does not match the bootstrap content.");
    }
    if (!sameOptional(proofPayload.version, content.version)) {
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

  return usableRelayBootstrapPosts(posts, options.onUnsupportedPost);
}

/**
 * Why this post cannot be used, or `null` if it can.
 *
 * This used to throw, and one record of the wrong type took the whole page
 * with it. The channel is public and append-only: anybody with an ETH key can
 * publish into it, nobody can FORGET somebody else's post, and every consumer
 * polls the same page. So a single legacy record — not ours, not removable —
 * would blind discovery for everyone, permanently.
 *
 * The Rust client learned this the same way and changed the same shape: after
 * a production incident on 2026-08-30, `get_messages_iterator` was page-strict
 * and one message the validator rejected failed every poll, leaving the
 * scheduler unable to see new v-programs at all (aleph-im/aleph-rs#386). The
 * answer there was to yield per message and carry on; the answer here is to
 * skip the record and say which one it was.
 */
export function unsupportedRelayBootstrapReason(
  post: RelayBootstrapPostRecord,
): string | null {
  if (post.type === "relay-bootstrap") {
    return "legacy relay-bootstrap record; only relay-bootstrap-v2 is supported";
  }
  if (post.type && post.type !== DEFAULT_ALEPH_BOOTSTRAP_POST_TYPE) {
    return `unsupported post type ${post.type}; expected ${DEFAULT_ALEPH_BOOTSTRAP_POST_TYPE}`;
  }
  return null;
}

/**
 * Drop what cannot be used, and report it rather than swallowing it.
 *
 * Silence would be the other way to get this wrong: a consumer whose relay
 * vanished from discovery deserves to know a record was skipped, not to watch
 * an empty list and guess.
 */
function usableRelayBootstrapPosts(
  posts: readonly RelayBootstrapPostRecord[],
  onUnsupportedPost?: (skipped: { hash: string | null | undefined; reason: string }) => void,
): RelayBootstrapPostRecord[] {
  return posts.filter((post) => {
    const reason = unsupportedRelayBootstrapReason(post);
    if (!reason) return true;
    onUnsupportedPost?.({ hash: post.itemHash ?? post.hash, reason });
    return false;
  });
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
  options: Pick<DiscoverAlephBootstrapOptions, "maxAgeMs" | "onUnsupportedPost"> & {
    now?: number;
  } = {},
): RelayBootstrapPostRecord[] {
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_BOOTSTRAP_MAX_AGE_MS;
  const now = options.now ?? Date.now();
  const selected = new Map<string, RelayBootstrapPostRecord>();

  for (const post of usableRelayBootstrapPosts(posts, options.onUnsupportedPost)) {
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

/**
 * Keep only the registrations a consumer published for itself.
 *
 * Profile is not fine enough. Every ephemeral relay an E2E run starts
 * registers under the same profile as the production one - as
 * `relay:<profile>:<name>-e2e-*` - and a registration outlives the machine it
 * describes, because guests self-publish with generated keys and no remaining
 * key can FORGET the post. So the channel accumulates registrations that are
 * indistinguishable from the real one by profile alone, and were alive when
 * they were written.
 *
 * Measured downstream: a browser probe wave against that list exhausted its
 * outbound stream budget on dead addresses and wrote off the one healthy relay
 * along with the corpses, leaving both browsers with nothing to dial.
 *
 * Omitting the scope returns every registration, which is the previous
 * behaviour and the right default for a consumer that wants to see the channel
 * rather than its own corner of it.
 */
export function filterRelayBootstrapPostsByRegistration(
  posts: readonly RelayBootstrapPostRecord[],
  registrationId?: string | readonly string[],
): RelayBootstrapPostRecord[] {
  const wanted = (
    typeof registrationId === "string" ? [registrationId] : (registrationId ?? [])
  )
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (wanted.length === 0) return [...posts];
  const allowed = new Set(wanted);
  return posts.filter(
    (post) =>
      post.content != null && allowed.has(String(post.content.registrationId)),
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

/**
 * The registrations discovery trusts: current, in scope (profile, registration)
 * and verified. The records keep their signatures, so a cache can store them and
 * verify them again later without asking Aleph.
 */
export async function discoverAlephBootstrapRecords(
  options: DiscoverAlephBootstrapOptions = {},
): Promise<RelayBootstrapPostRecord[]> {
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

    const selectedPosts = filterRelayBootstrapPostsByRegistration(
      filterRelayBootstrapPostsByProfile(
        selectCurrentRelayBootstrapPosts(collectedPosts, {
          maxAgeMs: options.maxAgeMs,
        }),
        options.profile,
      ),
      options.registrationId,
    );
    const trustedPosts = await filterTrustedRelayBootstrapPosts(selectedPosts, {
      requireDualKeyAttestation: options.requireDualKeyAttestation,
      verifyDualKeyAttestation: options.verifyDualKeyAttestation,
    });
    const addrs = relayBootstrapPostsToMultiaddrs(
      trustedPosts,
      browserDialableOnly,
      options.allowInsecureWebSockets ?? false,
    );
    if (addrs.length > 0) {
      return trustedPosts;
    }

    if (pagePosts.length < pagination) {
      break;
    }
  }

  return [];
}

export async function discoverAlephBootstrapMultiaddrs(
  options: DiscoverAlephBootstrapOptions = {},
): Promise<string[]> {
  const records = await discoverAlephBootstrapRecords(options);
  return relayBootstrapPostsToMultiaddrs(
    records,
    options.browserDialableOnly ?? true,
    options.allowInsecureWebSockets ?? false,
  );
}

function relayBootstrapPostsToMultiaddrs(
  posts: readonly RelayBootstrapPostRecord[],
  browserDialableOnly: boolean,
  allowInsecureWebSockets: boolean,
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
        allowInsecureWebSockets,
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

// ---------------------------------------------------------------------------
// Relays remembered between starts (#266)
//
// Discovery asks Aleph and verifies every proof before an app can dial
// anything: seconds in Node, up to a quarter of a minute in a browser on a slow
// network, for a list that rarely changes between two visits. The cache keeps
// the records discovery trusted, with their signatures, so the next start can
// dial them at once and ask Aleph afterwards, or not at all while the cache is
// fresh (the metadata rule of #119: talk to Aleph only when needed).
// ---------------------------------------------------------------------------

/** Where the cache keeps its JSON. `localStorage` fits; Node passes its own. */
export interface RelayCacheStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

export interface AlephRelayCacheOptions {
  /** Defaults to `globalThis.localStorage` where it can be used, else memory. */
  storage?: RelayCacheStorage | null;
  /** Defaults to {@link relayCacheKey} of the discovery scope. */
  key?: string;
  /** A record older than this (by its `updatedAt`) is dropped on load. Default: the registration max age. */
  maxAgeMs?: number;
  /** A relay that failed this many connection attempts is dropped on load. Default 3. */
  maxFailures?: number;
  /** Verify dual-key records again on load. Default true. */
  verifyDualKeyAttestation?: boolean;
  now?: () => number;
}

export interface AlephRelayCache {
  readonly key: string;
  /** The remembered records that are still current, not failing, and verify again. */
  load(): Promise<RelayBootstrapPostRecord[]>;
  /** When the records were last saved, or null when nothing is stored. */
  savedAt(): Promise<number | null>;
  /** Replace the records with what discovery just trusted; failure counts start over. */
  save(records: readonly RelayBootstrapPostRecord[]): Promise<void>;
  recordFailure(peerId: string): Promise<void>;
  recordSuccess(peerId: string): Promise<void>;
  clear(): Promise<void>;
}

interface StoredRelayCache {
  version: 1;
  savedAt: number;
  records: RelayBootstrapPostRecord[];
  failures: Record<string, number>;
}

const RELAY_CACHE_KEY_PREFIX = "le-space:aleph-bootstrap:relays:v1";
const DEFAULT_RELAY_CACHE_MAX_FAILURES = 3;

function scopeList(value?: string | readonly string[]): string {
  const list = (typeof value === "string" ? [value] : (value ?? []))
    .map((entry) => entry.trim())
    .filter(Boolean)
    .sort();
  return list.length > 0 ? list.join(",") : "*";
}

/**
 * One cache per discovery scope, so two apps on one origin (or one app with
 * two scopes) never hand each other relays they did not ask for.
 */
export function relayCacheKey(
  options: Pick<DiscoverAlephBootstrapOptions, "channel" | "ref" | "profile" | "registrationId"> = {},
): string {
  return [
    RELAY_CACHE_KEY_PREFIX,
    options.channel ?? DEFAULT_ALEPH_BOOTSTRAP_CHANNEL,
    options.ref ?? DEFAULT_ALEPH_BOOTSTRAP_REF,
    scopeList(options.profile),
    scopeList(options.registrationId),
  ].join(":");
}

/** A storage that lives as long as the process: for Node, tests, or browsers without `localStorage`. */
export function memoryRelayCacheStorage(): RelayCacheStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

function defaultRelayCacheStorage(): RelayCacheStorage {
  try {
    const storage = (globalThis as { localStorage?: RelayCacheStorage }).localStorage;
    if (storage) {
      // private modes and blocked site data throw on use, not on access
      const probe = `${RELAY_CACHE_KEY_PREFIX}:probe`;
      storage.setItem(probe, "1");
      storage.removeItem(probe);
      return storage;
    }
  } catch {
    // fall through to memory
  }
  return memoryRelayCacheStorage();
}

function relayPeerId(record: RelayBootstrapPostRecord): string | null {
  return record.content?.peerId ?? null;
}

/**
 * Remember trusted relay records between starts.
 *
 * Relay addresses are public, so `localStorage` is a fine place for them. What
 * the cache stores are the signed records, and dual-key records are verified
 * again on every load, so an entry edited in storage is not dialled. A
 * wallet-signed record cannot be checked offline (Aleph checked the sender);
 * it is as trustworthy as the origin's storage.
 *
 * The cache never throws for storage trouble: a full, blocked or corrupt store
 * reads as empty and refuses writes silently. It is an optimisation, never a
 * reason for a start to fail.
 */
export function createAlephRelayCache(options: AlephRelayCacheOptions = {}): AlephRelayCache {
  const storage = options.storage ?? defaultRelayCacheStorage();
  const key = options.key ?? relayCacheKey();
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_BOOTSTRAP_MAX_AGE_MS;
  const maxFailures = options.maxFailures ?? DEFAULT_RELAY_CACHE_MAX_FAILURES;
  const now = options.now ?? Date.now;

  async function read(): Promise<StoredRelayCache | null> {
    try {
      const raw = await storage.getItem(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<StoredRelayCache>;
      if (parsed?.version !== 1 || !Array.isArray(parsed.records)) return null;
      return {
        version: 1,
        savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : 0,
        records: parsed.records,
        failures: parsed.failures && typeof parsed.failures === "object" ? parsed.failures : {},
      };
    } catch {
      return null;
    }
  }

  async function write(value: StoredRelayCache): Promise<void> {
    try {
      await storage.setItem(key, JSON.stringify(value));
    } catch {
      // quota or blocked storage: the next start asks Aleph instead
    }
  }

  async function changeFailures(peerId: string, change: (count: number) => number): Promise<void> {
    const stored = await read();
    if (!stored || !stored.records.some((record) => relayPeerId(record) === peerId)) return;
    const next = change(stored.failures[peerId] ?? 0);
    if (next <= 0) delete stored.failures[peerId];
    else stored.failures[peerId] = next;
    await write(stored);
  }

  return {
    key,
    async load() {
      const stored = await read();
      if (!stored) return [];
      const current = stored.records.filter((record) => {
        const content = record?.content;
        if (!content || typeof content.updatedAt !== "number") return false;
        if (unsupportedRelayBootstrapReason(record)) return false;
        if (now() - content.updatedAt > maxAgeMs) return false;
        return (stored.failures[content.peerId] ?? 0) < maxFailures;
      });
      return filterTrustedRelayBootstrapPosts(current, {
        verifyDualKeyAttestation: options.verifyDualKeyAttestation ?? true,
      });
    },
    async savedAt() {
      return (await read())?.savedAt ?? null;
    },
    async save(records) {
      await write({ version: 1, savedAt: now(), records: [...records], failures: {} });
    },
    recordFailure: (peerId) => changeFailures(peerId, (count) => count + 1),
    recordSuccess: (peerId) => changeFailures(peerId, () => 0),
    async clear() {
      try {
        await storage.removeItem(key);
      } catch {
        // nothing to clear then
      }
    },
  };
}

/**
 * When cache-first discovery asks Aleph:
 * - `stale`: only when the cache is empty or older than `refreshAfterMs` (and,
 *   in {@link alephBootstrapDiscovery}, when no remembered relay answers)
 * - `always`: in the background on every start
 * - `never`: not at all
 */
export type RelayRefreshPolicy = "stale" | "always" | "never";

export interface DiscoverAlephBootstrapCachedOptions extends DiscoverAlephBootstrapOptions {
  /** Defaults to a {@link createAlephRelayCache} keyed by the discovery scope. */
  cache?: AlephRelayCache;
  /** Default `stale`. */
  refresh?: RelayRefreshPolicy;
  /** A cache saved longer ago than this is stale. Default 6 hours. */
  refreshAfterMs?: number;
  now?: () => number;
}

export interface RelayRefreshResult {
  /** The relays Aleph lists now. */
  addrs: string[];
  /** Addresses Aleph lists that the cache did not have. */
  added: string[];
  /** Cached addresses Aleph no longer lists. */
  removed: string[];
}

export interface CachedDiscoveryResult {
  /** The remembered relays, available without asking Aleph. */
  addrs: string[];
  fromCache: boolean;
  /**
   * The refresh from Aleph, when the policy asks for one: it updates the cache
   * and resolves with what changed. It rejects when Aleph cannot be read, and
   * the cache then stays as it was.
   */
  refreshed: Promise<RelayRefreshResult> | null;
}

export const DEFAULT_RELAY_REFRESH_AFTER_MS = 6 * 60 * 60 * 1000;

function cachedRecordsToMultiaddrs(
  records: readonly RelayBootstrapPostRecord[],
  options: DiscoverAlephBootstrapOptions,
): string[] {
  return relayBootstrapPostsToMultiaddrs(
    filterRelayBootstrapPostsByRegistration(
      filterRelayBootstrapPostsByProfile(records, options.profile),
      options.registrationId,
    ),
    options.browserDialableOnly ?? true,
    options.allowInsecureWebSockets ?? false,
  );
}

function cacheFor(options: DiscoverAlephBootstrapCachedOptions): AlephRelayCache {
  return (
    options.cache ??
    createAlephRelayCache({ key: relayCacheKey(options), maxAgeMs: options.maxAgeMs, now: options.now })
  );
}

/**
 * Ask Aleph now and replace the cache with what it lists. A lookup that finds
 * nothing keeps the cache: an empty answer is more often a hiccup than every
 * relay being gone, and the remembered relays still age out on their own.
 */
export async function refreshAlephRelayCache(
  options: DiscoverAlephBootstrapCachedOptions = {},
  previous: readonly string[] = [],
): Promise<RelayRefreshResult> {
  const cache = cacheFor(options);
  const records = await discoverAlephBootstrapRecords(options);
  if (records.length === 0) return { addrs: [...previous], added: [], removed: [] };
  await cache.save(records);
  const addrs = cachedRecordsToMultiaddrs(records, options);
  const before = new Set(previous);
  const now = new Set(addrs);
  return {
    addrs,
    added: addrs.filter((addr) => !before.has(addr)),
    removed: previous.filter((addr) => !now.has(addr)),
  };
}

/**
 * Relays to dial right away, from the cache, and the refresh from Aleph as a
 * promise, so a start never waits for Aleph while it has relays it knows.
 */
export async function discoverAlephBootstrapMultiaddrsCached(
  options: DiscoverAlephBootstrapCachedOptions = {},
): Promise<CachedDiscoveryResult> {
  const cache = cacheFor(options);
  const now = options.now ?? Date.now;
  const addrs = cachedRecordsToMultiaddrs(await cache.load(), options);
  const savedAt = await cache.savedAt();
  const stale =
    addrs.length === 0 ||
    savedAt == null ||
    now() - savedAt > (options.refreshAfterMs ?? DEFAULT_RELAY_REFRESH_AFTER_MS);
  const policy = options.refresh ?? "stale";
  const refreshed =
    policy === "always" || (policy === "stale" && stale)
      ? refreshAlephRelayCache({ ...options, cache }, addrs)
      : null;
  return { addrs, fromCache: addrs.length > 0, refreshed };
}

// ---------------------------------------------------------------------------
// libp2p peer discovery without waiting for Aleph
// ---------------------------------------------------------------------------

// The same global symbols @libp2p/interface exports, so the service works with
// whichever libp2p version the app runs without importing its interfaces.
const PEER_DISCOVERY_SYMBOL = Symbol.for("@libp2p/peer-discovery");
const SERVICE_CAPABILITIES_SYMBOL = Symbol.for("@libp2p/service-capabilities");

export interface AlephBootstrapDiscoveryInit extends DiscoverAlephBootstrapCachedOptions {
  /** Peer store tag for the relays. Default `aleph-bootstrap`. */
  tagName?: string;
  tagValue?: number;
  tagTTL?: number;
  /**
   * With `refresh: 'stale'`: when none of the remembered relays is connected
   * this long after they were announced, ask Aleph after all. Default 10 s;
   * 0 turns it off.
   */
  refreshIfSilentMs?: number;
}

/** What the service needs from libp2p's components. */
interface AlephBootstrapDiscoveryComponents {
  peerStore: { merge(peerId: unknown, data: unknown): Promise<unknown> };
  connectionManager: {
    openConnection(peerId: unknown): Promise<unknown>;
    getConnections(peerId?: unknown): unknown[];
  };
  logger?: { forComponent(name: string): ((...args: unknown[]) => void) & { error?: (...args: unknown[]) => void } };
}

function groupMultiaddrsByPeer(addrs: readonly string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const addr of addrs) {
    const peerId = addr.split("/p2p/").at(-1);
    if (!peerId) continue;
    groups.set(peerId, [...(groups.get(peerId) ?? []), addr]);
  }
  return groups;
}

class AlephBootstrapDiscovery extends EventTarget {
  readonly [PEER_DISCOVERY_SYMBOL] = this;
  readonly [SERVICE_CAPABILITIES_SYMBOL] = ["@libp2p/peer-discovery"];
  readonly [Symbol.toStringTag] = "@le-space/aleph-bootstrap-discovery";

  private started = false;
  private silenceTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly components: AlephBootstrapDiscoveryComponents;
  private readonly init: AlephBootstrapDiscoveryInit;
  private readonly cache: AlephRelayCache;
  private readonly log: (...args: unknown[]) => void;

  // no parameter properties: consumers load this file with Node's type stripping
  constructor(components: AlephBootstrapDiscoveryComponents, init: AlephBootstrapDiscoveryInit) {
    super();
    this.components = components;
    this.init = init;
    this.cache = cacheFor(init);
    this.log = components.logger?.forComponent("le-space:aleph-bootstrap") ?? (() => {});
  }

  isStarted(): boolean {
    return this.started;
  }

  start(): void {
    this.started = true;
  }

  afterStart(): void {
    void this.discover().catch((error) => this.log("relay discovery failed - %s", String(error)));
  }

  stop(): void {
    this.started = false;
    clearTimeout(this.silenceTimer);
    this.silenceTimer = undefined;
  }

  private async discover(): Promise<void> {
    const options = { ...this.init, cache: this.cache };
    const { addrs, refreshed } = await discoverAlephBootstrapMultiaddrsCached(options);
    this.log("%d remembered relay addresses", addrs.length);
    await this.announce(addrs);
    if (refreshed) {
      this.follow(refreshed);
      return;
    }
    const silentMs = this.init.refreshIfSilentMs ?? 10_000;
    if ((this.init.refresh ?? "stale") !== "stale" || silentMs <= 0 || addrs.length === 0) return;
    this.silenceTimer = setTimeout(() => {
      if (!this.started || this.connectedToAny(addrs)) return;
      this.log("no remembered relay answered within %d ms; asking Aleph", silentMs);
      this.follow(refreshAlephRelayCache(options, addrs));
    }, silentMs);
  }

  private follow(refresh: Promise<RelayRefreshResult>): void {
    refresh
      .then((result) => {
        this.log("Aleph lists %d relay addresses (%d new)", result.addrs.length, result.added.length);
        return this.announce(result.addrs);
      })
      .catch((error) => this.log("refreshing relays from Aleph failed - %s", String(error)));
  }

  private connectedToAny(addrs: readonly string[]): boolean {
    const wanted = new Set(groupMultiaddrsByPeer(addrs).keys());
    return this.components.connectionManager
      .getConnections()
      .some((connection) => wanted.has(String((connection as { remotePeer?: unknown }).remotePeer)));
  }

  private async announce(addrs: readonly string[]): Promise<void> {
    for (const [peerIdString, list] of groupMultiaddrsByPeer(addrs)) {
      if (!this.started) return;
      let id: ReturnType<typeof peerIdFromString>;
      let multiaddrs: ReturnType<typeof multiaddr>[];
      try {
        id = peerIdFromString(peerIdString);
        multiaddrs = list.map((addr) => multiaddr(addr));
      } catch (error) {
        this.log("skipping relay %s - %s", peerIdString, String(error));
        continue;
      }
      await this.components.peerStore.merge(id, {
        tags: {
          [this.init.tagName ?? "aleph-bootstrap"]: {
            value: this.init.tagValue ?? 50,
            ttl: this.init.tagTTL,
          },
        },
        multiaddrs,
      });
      if (!this.started) return;
      this.dispatchEvent(new CustomEvent("peer", { detail: { id, multiaddrs } }));
      this.components.connectionManager
        .openConnection(id)
        .then(() => this.cache.recordSuccess(peerIdString))
        .catch((error) => {
          this.log("could not dial relay %s - %s", peerIdString, String(error));
          return this.cache.recordFailure(peerIdString);
        });
    }
  }
}

/**
 * libp2p peer discovery from Aleph that never holds up the start: it announces
 * and dials the remembered relays at once, refreshes from Aleph according to
 * `refresh`, and announces what the refresh finds. Use it in place of awaiting
 * {@link createLibp2pAlephBootstrap}:
 *
 * ```ts
 * createLibp2p({ peerDiscovery: [alephBootstrapDiscovery({ profile: 'orbitdb-relay' })] })
 * ```
 */
export function alephBootstrapDiscovery(
  init: AlephBootstrapDiscoveryInit = {},
): (components: AlephBootstrapDiscoveryComponents) => AlephBootstrapDiscovery {
  return (components) => new AlephBootstrapDiscovery(components, init);
}
