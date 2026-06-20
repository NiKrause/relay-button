import {
  createRelayBootstrapPost,
  fetchAlephBootstrapPosts,
  DEFAULT_ALEPH_API_HOST,
  DEFAULT_ALEPH_BOOTSTRAP_COMPACT_POST_TYPE,
  DEFAULT_ALEPH_BOOTSTRAP_POST_TYPE,
  signRelayBootstrapAuthorization,
  signRelayBootstrapProof,
  selectCurrentRelayBootstrapPosts,
  type RelayBootstrapAuthorizationRecord,
  type RelayBootstrapProofRecord,
  type RelayBootstrapProofSigner,
} from "../../aleph-bootstrap/src/index.ts";
import type {
  AlephBroadcastMessage,
  AlephBroadcastResponse,
  MessageHasher,
  MessageSigner,
} from "@le-space/shared-types";

import {
  broadcastAlephMessage,
  signAlephMessage,
  type JsonFetchLike,
} from "./broadcast.ts";
import { forgetAlephMessages } from "./forget.ts";

export interface RelayBootstrapPublicationResult {
  status: "published" | "skipped";
  reason?: string;
  itemHash?: string;
  message?: AlephBroadcastMessage;
  response?: AlephBroadcastResponse;
  httpStatus?: number;
  publishedMultiaddrs?: string[];
  publishedBrowserMultiaddrs?: string[];
  forgottenHashes?: string[];
  forgetResult?: Awaited<ReturnType<typeof forgetAlephMessages>>;
}

export interface RelayBootstrapVisibilityResult {
  itemHash: string | null;
  hash: string | null;
  sender?: string | null;
  registrationId?: string;
  peerId?: string;
  multiaddrs: string[];
  browserMultiaddrs: string[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForRelayBootstrapRegistration(args: {
  sender?: string;
  fetch: JsonFetchLike;
  registrationId?: string;
  peerId?: string;
  apiHost?: string;
  channel?: string;
  ref?: string;
  postType?: string;
  attempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onAttempt?: (
    match: RelayBootstrapVisibilityResult | null,
    attempt: number,
    attempts: number,
  ) => void;
}): Promise<RelayBootstrapVisibilityResult | null> {
  const attempts = Math.max(1, Number(args.attempts ?? 10));
  const delayMs = Math.max(0, Number(args.delayMs ?? 2000));
  const expectedSender = args.sender?.trim().toLowerCase() || null;
  const expectedRegistrationId = args.registrationId?.trim() || null;
  const expectedPeerId = args.peerId?.trim() || null;
  const postType = args.postType ?? DEFAULT_ALEPH_BOOTSTRAP_COMPACT_POST_TYPE;
  const sleepImpl = args.sleep ?? sleep;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const posts = await fetchAlephBootstrapPosts({
      apiHost: args.apiHost ?? DEFAULT_ALEPH_API_HOST,
      channel: args.channel,
      ref: args.ref,
      postType,
      fetch: args.fetch as typeof fetch,
    });
    const currentPosts = selectCurrentRelayBootstrapPosts(posts);
    const match = currentPosts.find((post) => {
      if (expectedSender && post.address?.toLowerCase() !== expectedSender) {
        return false;
      }
      if (expectedRegistrationId && post.content?.registrationId === expectedRegistrationId) {
        return true;
      }
      if (expectedPeerId && post.content?.peerId === expectedPeerId) {
        return true;
      }
      return false;
    });

    if (match?.content) {
      const visibleRegistration = {
        itemHash: match.itemHash ?? null,
        hash: match.hash ?? null,
        sender: typeof match.address === "string" ? match.address : null,
        registrationId: match.content.registrationId,
        peerId: match.content.peerId,
        multiaddrs: Array.isArray(match.content.multiaddrs) ? match.content.multiaddrs : [],
        browserMultiaddrs: Array.isArray(match.content.browserMultiaddrs)
          ? match.content.browserMultiaddrs
          : [],
      };
      args.onAttempt?.(visibleRegistration, attempt + 1, attempts);
      return visibleRegistration;
    }

    args.onAttempt?.(null, attempt + 1, attempts);

    if (attempt < attempts - 1) {
      await sleepImpl(delayMs);
    }
  }

  return null;
}

export async function publishRelayBootstrapRegistration(args: {
  sender: string;
  signer: MessageSigner;
  hasher: MessageHasher;
  fetch: JsonFetchLike;
  peerId: string;
  multiaddrs: string[];
  browserMultiaddrs?: string[];
  registrationId?: string;
  apiHost?: string;
  channel?: string;
  ref?: string;
  postType?: string;
  compactMultiaddrLimit?: number;
  profile?: string;
  version?: string;
  ownerAddress?: string;
  publisherAddress?: string;
  ownerSigner?: RelayBootstrapProofSigner;
  publisherSigner?: RelayBootstrapProofSigner;
  ownerAuthorization?: RelayBootstrapAuthorizationRecord;
  relayProof?: RelayBootstrapProofRecord;
  authorizationIssuedAt?: number;
  authorizationExpiresAt?: number;
  instanceItemHash?: string;
  forgetPrevious?: boolean;
  forgetPreviousReason?: string;
  sync?: boolean;
  now?: number;
}): Promise<RelayBootstrapPublicationResult> {
  const publisherAddress = args.publisherAddress ?? args.sender;
  const ownerAddress = args.ownerAddress;
  const postType = args.postType ?? DEFAULT_ALEPH_BOOTSTRAP_COMPACT_POST_TYPE;
  const compact = postType === DEFAULT_ALEPH_BOOTSTRAP_COMPACT_POST_TYPE;
  let ownerAuthorization = args.ownerAuthorization;
  let relayProof = args.relayProof;

  if (!ownerAuthorization && ownerAddress && args.ownerSigner) {
    ownerAuthorization = await signRelayBootstrapAuthorization({
      ownerAddress,
      publisherAddress,
      peerId: args.peerId,
      registrationId: args.registrationId,
      profile: args.profile,
      version: args.version,
      instanceItemHash: args.instanceItemHash,
      issuedAt: args.authorizationIssuedAt ?? args.now ?? Date.now(),
      expiresAt: args.authorizationExpiresAt,
      signer: args.ownerSigner,
    });
  }

  if (!relayProof && args.publisherSigner) {
    relayProof = await signRelayBootstrapProof({
      publisherAddress,
      peerId: args.peerId,
      multiaddrs: args.multiaddrs,
      browserMultiaddrs: args.browserMultiaddrs,
      registrationId: args.registrationId,
      profile: args.profile,
      version: args.version,
      updatedAt: args.now ?? Date.now(),
      compact,
      compactMultiaddrLimit: args.compactMultiaddrLimit,
      signer: args.publisherSigner,
    });
  }

  const unsigned = await createRelayBootstrapPost({
    sender: args.sender,
    peerId: args.peerId,
    multiaddrs: args.multiaddrs,
    browserMultiaddrs: args.browserMultiaddrs,
    registrationId: args.registrationId,
    channel: args.channel,
    ref: args.ref,
    postType,
    profile: args.profile,
    version: args.version,
    ownerAddress,
    publisherAddress,
    authorization: ownerAuthorization,
    relayProof,
    compact,
    compactMultiaddrLimit: args.compactMultiaddrLimit,
    now: args.now,
    hasher: args.hasher,
  });

  const content = JSON.parse(unsigned.item_content) as {
    content?: {
      multiaddrs?: string[];
      browserMultiaddrs?: string[];
    };
  };

  if ((content.content?.multiaddrs?.length ?? 0) === 0) {
    return {
      status: "skipped",
      reason: "No public relay multiaddrs remained after filtering.",
      publishedMultiaddrs: [],
      publishedBrowserMultiaddrs: content.content?.browserMultiaddrs ?? [],
    };
  }

  const message = await signAlephMessage(unsigned, args.signer);
  const { response, httpStatus } = await broadcastAlephMessage(message, {
    apiHost: args.apiHost ?? DEFAULT_ALEPH_API_HOST,
    sync: args.sync ?? true,
    fetch: args.fetch,
  });

  let forgottenHashes: string[] = [];
  let forgetResult: Awaited<ReturnType<typeof forgetAlephMessages>> | undefined;
  if (args.forgetPrevious && args.registrationId) {
    const previousPostTypes = compact
      ? [postType, DEFAULT_ALEPH_BOOTSTRAP_POST_TYPE]
      : [postType];
    const previousPosts = (
      await Promise.all(
        previousPostTypes.map((previousPostType) =>
          fetchAlephBootstrapPosts({
            apiHost: args.apiHost ?? DEFAULT_ALEPH_API_HOST,
            channel: args.channel,
            ref: args.ref,
            postType: previousPostType,
            fetch: args.fetch as typeof fetch,
          }),
        ),
      )
    ).flat();

    const forgottenHashSet = new Set(
      previousPosts
        .filter((post) => {
          const hash = post.itemHash ?? post.hash;
          if (!hash || hash === unsigned.item_hash) return false;
          if (post.address?.toLowerCase() !== args.sender.toLowerCase()) {
            return false;
          }
          const content = post.content;
          if (!content) return false;
          if (content.registrationId === args.registrationId) return true;
          if (content.peerId !== args.peerId) return false;
          return !args.profile || content.profile === args.profile;
        })
        .map((post) => post.itemHash ?? post.hash ?? "")
        .filter(Boolean),
    );
    forgottenHashes = [...forgottenHashSet];

    if (forgottenHashes.length > 0) {
      forgetResult = await forgetAlephMessages({
        sender: args.sender,
        hashes: forgottenHashes,
        reason:
          args.forgetPreviousReason ??
          `Replace older relay bootstrap records for ${args.registrationId}`,
        signer: args.signer,
        hasher: args.hasher,
        fetch: args.fetch,
        apiHost: args.apiHost ?? DEFAULT_ALEPH_API_HOST,
        sync: args.sync ?? true,
      });
    }
  }

  return {
    status: "published",
    itemHash: unsigned.item_hash,
    message,
    response,
    httpStatus,
    publishedMultiaddrs: content.content?.multiaddrs ?? [],
    publishedBrowserMultiaddrs:
      content.content?.browserMultiaddrs ?? content.content?.multiaddrs ?? [],
    forgottenHashes,
    forgetResult,
  };
}
