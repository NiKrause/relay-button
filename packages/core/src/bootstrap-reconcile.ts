import {
  fetchAlephBootstrapPosts,
  selectCurrentRelayBootstrapPosts,
} from "../../aleph-bootstrap/src/index.ts";
import type {
  CrnRecord,
  MessageHasher,
  MessageSigner,
} from "@le-space/shared-types";

import { publishRelayBootstrapRegistration } from "./bootstrap-registration.ts";
import { forgetAlephMessages } from "./forget.ts";
import { fetchUcGoPeerMetadata } from "./guest.ts";
import { DEFAULT_ALEPH_API_HOST } from "./manifests.ts";
import type { FetchLike } from "./manifests.ts";
import { fetchVmRuntime } from "./runtime.ts";

type JsonFetchLike = FetchLike;

type InstanceMessageLike = {
  item_hash: string
  status?: string
  confirmed?: boolean
  content?: {
    metadata?: { name?: string | null } | null
  } | null
}

export type RelayMetadataShape = {
  peerId: string
  probeMultiaddrs: string[]
  browserBootstrapMultiaddrs: string[]
}

export interface OwnerRelayBootstrapReconcileResult {
  refreshedRegistrations: string[]
  forgottenHashes: string[]
  skippedInstanceHashes: string[]
  errors: Array<{
    phase: string
    itemHash?: string
    registrationId?: string
    message: string
  }>
}

export function createRelayBootstrapRegistrationId(
  profile: string,
  instanceName: string | null | undefined,
  itemHash: string,
): string {
  const normalizedName = String(instanceName ?? "").trim()
  const normalizedHash = String(itemHash ?? "").trim()
  if (!normalizedHash) {
    return `relay:${profile}:${normalizedName || "instance"}`
  }
  return `relay:${profile}:${normalizedName || normalizedHash}:${normalizedHash}`
}

function secureBootstrapMetadataUrl(proxyUrl: string | null | undefined): string | null {
  const normalized = String(proxyUrl ?? "").trim()
  if (!normalized) return null
  try {
    return new URL("/bootstrap/metadata", normalized).toString()
  } catch {
    return null
  }
}

function extractRelayMetadata(payload: unknown): RelayMetadataShape | null {
  const metadata =
    payload &&
    typeof payload === "object" &&
    (payload as { metadata?: unknown }).metadata &&
    typeof (payload as { metadata?: unknown }).metadata === "object"
      ? ((payload as { metadata: Record<string, unknown> }).metadata)
      : null

  const peerId = typeof metadata?.peer_id === "string" ? metadata.peer_id : null
  const probeMultiaddrs = Array.isArray(metadata?.probe_multiaddrs)
    ? metadata.probe_multiaddrs.filter((entry): entry is string => typeof entry === "string")
    : []
  const browserBootstrapMultiaddrs = Array.isArray(metadata?.browser_bootstrap_multiaddrs)
    ? metadata.browser_bootstrap_multiaddrs.filter((entry): entry is string => typeof entry === "string")
    : []

  if (!peerId || probeMultiaddrs.length === 0) return null

  return {
    peerId,
    probeMultiaddrs,
    browserBootstrapMultiaddrs,
  }
}

async function fetchOwnerInstances(
  address: string,
  options: {
    apiHost?: string
    fetch: JsonFetchLike
  },
): Promise<InstanceMessageLike[]> {
  const url = new URL("/api/v0/messages.json", options.apiHost ?? DEFAULT_ALEPH_API_HOST)
  url.searchParams.set("msgTypes", "INSTANCE")
  url.searchParams.set("addresses", address)
  url.searchParams.set("message_statuses", "processed,pending,rejected")
  url.searchParams.set("pagination", "100")
  url.searchParams.set("page", "1")
  url.searchParams.set("sortOrder", "-1")

  const response = await options.fetch(url.toString(), { cache: "no-cache" })
  if (!response.ok) {
    throw new Error(`Instance list request failed: ${response.status}`)
  }

  const payload = (await response.json()) as { messages?: InstanceMessageLike[] }
  return (payload.messages ?? []).map((message) => ({
    ...message,
    status:
      typeof message.status === "string" && message.status.trim()
        ? message.status
        : message.confirmed
          ? "processed"
          : "pending",
  }))
}

export async function fetchRelayMetadataForRuntime(args: {
  runtime: Awaited<ReturnType<typeof fetchVmRuntime>>
  fetch: JsonFetchLike
  preferSecureMetadata?: boolean
  attempts?: number
  delayMs?: number
  timeoutMs?: number
  onAttempt?: (result: {
    payload: unknown
    ready: boolean
    attempt: number
    attempts: number
    requestUrl: string
    ok: boolean
    status: number | null
    error?: string | null
    metadataUrl: string | null
    hostIpv4: string | null
    setupPort: number
  }) => void
}): Promise<RelayMetadataShape | null> {
  const setupPort = args.runtime.mappedPorts?.["80"]?.host ?? 80
  const metadataUrl = args.preferSecureMetadata
    ? secureBootstrapMetadataUrl(args.runtime.proxyUrl)
    : null

  if (args.preferSecureMetadata && !metadataUrl) {
    return null
  }

  const payload = await fetchUcGoPeerMetadata({
    hostIpv4: args.runtime.hostIpv4 ?? "",
    setupPort,
    metadataUrl,
    fetch: args.fetch,
    attempts: args.attempts,
    delayMs: args.delayMs,
    timeoutMs: args.timeoutMs,
    isReady: (result) => extractRelayMetadata(result.payload) != null,
    onAttempt: (result) => {
      args.onAttempt?.({
        ...result,
        metadataUrl,
        hostIpv4: args.runtime.hostIpv4 ?? null,
        setupPort,
      })
    },
  }).catch(() => null)

  return extractRelayMetadata(payload)
}

export async function reconcileOwnerRelayBootstrapRegistrations(args: {
  instanceOwnerAddress: string
  sender: string
  signer: MessageSigner
  hasher: MessageHasher
  fetch: JsonFetchLike
  profile: string
  apiHost?: string
  channel?: string
  ref?: string
  postType?: string
  version?: string
  ownerAddress?: string
  ownerSigner?: MessageSigner
  publisherAddress?: string
  publisherSigner?: MessageSigner
  crns?: CrnRecord[]
  crnListUrl?: string
  preferSecureMetadata?: boolean
  current?: {
    itemHash: string
    registrationId: string
    peerId: string
    probeMultiaddrs: string[]
    browserBootstrapMultiaddrs?: string[]
  } | null
}): Promise<OwnerRelayBootstrapReconcileResult> {
  const result: OwnerRelayBootstrapReconcileResult = {
    refreshedRegistrations: [],
    forgottenHashes: [],
    skippedInstanceHashes: [],
    errors: [],
  }

  const liveRegistrationIds = new Set<string>()
  if (args.current?.registrationId) {
    liveRegistrationIds.add(args.current.registrationId)
    result.refreshedRegistrations.push(args.current.registrationId)
  }

  const instances = await fetchOwnerInstances(args.instanceOwnerAddress, {
    apiHost: args.apiHost,
    fetch: args.fetch,
  })
  const processedInstances = instances.filter((instance) => {
    const status = String(instance.status ?? "").trim().toLowerCase()
    return status === "processed"
  })

  for (const instance of processedInstances) {
    if (instance.item_hash === args.current?.itemHash) continue

    const registrationId = createRelayBootstrapRegistrationId(
      args.profile,
      instance.content?.metadata?.name,
      instance.item_hash,
    )

    try {
      const runtime = await fetchVmRuntime({
        itemHash: instance.item_hash,
        fetch: args.fetch,
        crns: args.crns,
        crnListUrl: args.crnListUrl,
      })

      if (!runtime.hostIpv4 || Object.keys(runtime.mappedPorts ?? {}).length === 0) {
        result.skippedInstanceHashes.push(instance.item_hash)
        continue
      }

      const relayMetadata = await fetchRelayMetadataForRuntime({
        runtime,
        fetch: args.fetch,
        preferSecureMetadata: args.preferSecureMetadata,
        attempts: 3,
        delayMs: 1000,
        timeoutMs: 10000,
      })
      if (!relayMetadata) {
        result.skippedInstanceHashes.push(instance.item_hash)
        continue
      }

      liveRegistrationIds.add(registrationId)
      await publishRelayBootstrapRegistration({
        sender: args.sender,
        signer: args.signer,
        hasher: args.hasher,
        fetch: args.fetch,
        apiHost: args.apiHost,
        channel: args.channel,
        ref: args.ref,
        postType: args.postType,
        peerId: relayMetadata.peerId,
        multiaddrs: relayMetadata.probeMultiaddrs,
        browserMultiaddrs: relayMetadata.browserBootstrapMultiaddrs,
        registrationId,
        ownerAddress: args.ownerAddress,
        publisherAddress: args.publisherAddress,
        ownerSigner: args.ownerSigner,
        publisherSigner: args.publisherSigner,
        forgetPrevious: true,
        profile: args.profile,
        version: args.version,
        instanceItemHash: instance.item_hash,
        sync: true,
      })
      result.refreshedRegistrations.push(registrationId)
    } catch (error) {
      result.errors.push({
        phase: "publish",
        itemHash: instance.item_hash,
        registrationId,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  try {
    const bootstrapPosts = await fetchAlephBootstrapPosts({
      apiHost: args.apiHost ?? DEFAULT_ALEPH_API_HOST,
      channel: args.channel,
      ref: args.ref,
      postType: args.postType,
      fetch: args.fetch as typeof fetch,
    })
    const currentPosts = selectCurrentRelayBootstrapPosts(bootstrapPosts)
    const staleHashes = currentPosts
      .filter(
        (post) =>
          post.address?.toLowerCase() === args.sender.toLowerCase() &&
          post.content?.profile === args.profile &&
          post.content?.registrationId &&
          !liveRegistrationIds.has(post.content.registrationId),
      )
      .map((post) => post.itemHash ?? post.hash ?? "")
      .filter(Boolean)

    if (staleHashes.length > 0) {
      await forgetAlephMessages({
        sender: args.sender,
        hashes: staleHashes,
        reason: `Forget stale ${args.profile} relay bootstrap registrations after owner reconcile`,
        signer: args.signer,
        hasher: args.hasher,
        fetch: args.fetch,
        apiHost: args.apiHost ?? DEFAULT_ALEPH_API_HOST,
        sync: true,
      })
      result.forgottenHashes.push(...staleHashes)
    }
  } catch (error) {
    result.errors.push({
      phase: "forget",
      message: error instanceof Error ? error.message : String(error),
    })
  }

  return result
}
