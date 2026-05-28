import { bootstrap } from "@libp2p/bootstrap";

export const DEFAULT_ALEPH_API_HOST = "https://api2.aleph.im";
export const DEFAULT_ALEPH_BOOTSTRAP_CHANNEL = "simple-todo";
export const DEFAULT_ALEPH_BOOTSTRAP_REF = "simple-todo-bootstrap";
export const DEFAULT_ALEPH_BOOTSTRAP_POST_TYPE = "relay-bootstrap";
export const DEFAULT_BOOTSTRAP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_BOOTSTRAP_PAGINATION = 50;

export interface RelayBootstrapContent {
  peerId: string;
  multiaddrs: string[];
  browserMultiaddrs?: string[];
  profile?: string;
  version?: string;
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
  postType?: string;
  page?: number;
  pagination?: number;
  maxAgeMs?: number;
  browserDialableOnly?: boolean;
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
  ref?: string;
  channel?: string;
  postType?: string;
  profile?: string;
  version?: string;
  now?: number;
  hasher: (payload: string) => Promise<string> | string;
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
  return (
    normalized.includes("/ws") ||
    normalized.includes("/wss") ||
    normalized.includes("/webtransport") ||
    normalized.includes("/webrtc-direct")
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
    if (options.browserDialableOnly && !isBrowserDialableMultiaddr(addr)) {
      return false;
    }
    return true;
  });
}

function normalizeRelayBootstrapContent(value: unknown): RelayBootstrapContent | null {
  if (!value || typeof value !== "object") return null;
  const content = value as Record<string, unknown>;
  const peerId = asTrimmedString(content.peerId);
  const updatedAt = asNumber(content.updatedAt);
  if (!peerId || updatedAt == null) return null;

  const multiaddrs = Array.isArray(content.multiaddrs)
    ? content.multiaddrs.filter((entry): entry is string => typeof entry === "string")
    : [];
  const browserMultiaddrs = Array.isArray(content.browserMultiaddrs)
    ? content.browserMultiaddrs.filter((entry): entry is string => typeof entry === "string")
    : undefined;

  return {
    peerId,
    multiaddrs: dedupeMultiaddrs(multiaddrs),
    browserMultiaddrs: browserMultiaddrs
      ? dedupeMultiaddrs(browserMultiaddrs)
      : undefined,
    profile: asTrimmedString(content.profile) ?? undefined,
    version: asTrimmedString(content.version) ?? undefined,
    updatedAt,
  };
}

function normalizeRelayBootstrapPostRecord(value: unknown): RelayBootstrapPostRecord | null {
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
  ref?: string;
  postType?: string;
  profile?: string;
  version?: string;
  now?: number;
}): RelayBootstrapPostContent {
  const now = args.now ?? Date.now() / 1000;
  const updatedAt = args.now ?? Date.now();

  return {
    type: args.postType ?? DEFAULT_ALEPH_BOOTSTRAP_POST_TYPE,
    address: args.sender,
    ...(args.ref ? { ref: args.ref } : {}),
    content: {
      peerId: args.peerId,
      multiaddrs: filterPublicMultiaddrs(args.multiaddrs),
      browserMultiaddrs: args.browserMultiaddrs
        ? filterPublicMultiaddrs(args.browserMultiaddrs, {
            browserDialableOnly: true,
          })
        : undefined,
      profile: args.profile,
      version: args.version,
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
    ref: args.ref ?? DEFAULT_ALEPH_BOOTSTRAP_REF,
    postType: args.postType ?? DEFAULT_ALEPH_BOOTSTRAP_POST_TYPE,
    profile: args.profile,
    version: args.version,
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
  url.searchParams.set(
    "types",
    options.postType ?? DEFAULT_ALEPH_BOOTSTRAP_POST_TYPE,
  );
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
  return (payload.posts ?? [])
    .map((entry) => normalizeRelayBootstrapPostRecord(entry))
    .filter((entry): entry is RelayBootstrapPostRecord => entry != null);
}

export async function discoverAlephBootstrapMultiaddrs(
  options: DiscoverAlephBootstrapOptions = {},
): Promise<string[]> {
  const posts = await fetchAlephBootstrapPosts(options);
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_BOOTSTRAP_MAX_AGE_MS;
  const now = Date.now();
  const browserDialableOnly = options.browserDialableOnly ?? true;

  const addrs: string[] = [];
  for (const post of posts) {
    const content = post.content;
    if (!content) continue;
    if (now - content.updatedAt > maxAgeMs) continue;

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
) {
  const list = await discoverAlephBootstrapMultiaddrs(options);
  return bootstrap({
    list,
    timeout: options.timeout,
    tagName: options.tagName,
  });
}
