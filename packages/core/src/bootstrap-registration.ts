import {
  createRelayBootstrapPost,
  fetchAlephBootstrapPosts,
  DEFAULT_ALEPH_API_HOST,
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
  registrationId?: string;
  peerId?: string;
  multiaddrs: string[];
  browserMultiaddrs: string[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForRelayBootstrapRegistration(args: {
  sender: string;
  fetch: JsonFetchLike;
  registrationId?: string;
  peerId?: string;
  apiHost?: string;
  channel?: string;
  ref?: string;
  postType?: string;
  attempts?: number;
  delayMs?: number;
}): Promise<RelayBootstrapVisibilityResult | null> {
  const attempts = Math.max(1, Number(args.attempts ?? 10));
  const delayMs = Math.max(0, Number(args.delayMs ?? 2000));
  const expectedSender = args.sender.trim().toLowerCase();
  const expectedRegistrationId = args.registrationId?.trim() || null;
  const expectedPeerId = args.peerId?.trim() || null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const posts = await fetchAlephBootstrapPosts({
      apiHost: args.apiHost ?? DEFAULT_ALEPH_API_HOST,
      channel: args.channel,
      ref: args.ref,
      postType: args.postType,
      fetch: args.fetch as typeof fetch,
    });
    const currentPosts = selectCurrentRelayBootstrapPosts(posts);
    const match = currentPosts.find((post) => {
      const senderMatches = post.address?.toLowerCase() === expectedSender;
      if (!senderMatches) return false;
      if (expectedRegistrationId && post.content?.registrationId === expectedRegistrationId) {
        return true;
      }
      if (expectedPeerId && post.content?.peerId === expectedPeerId) {
        return true;
      }
      return false;
    });

    if (match?.content) {
      return {
        itemHash: match.itemHash ?? null,
        hash: match.hash ?? null,
        registrationId: match.content.registrationId,
        peerId: match.content.peerId,
        multiaddrs: Array.isArray(match.content.multiaddrs) ? match.content.multiaddrs : [],
        browserMultiaddrs: Array.isArray(match.content.browserMultiaddrs)
          ? match.content.browserMultiaddrs
          : [],
      };
    }

    if (attempt < attempts - 1) {
      await sleep(delayMs);
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
    postType: args.postType,
    profile: args.profile,
    version: args.version,
    ownerAddress,
    publisherAddress,
    authorization: ownerAuthorization,
    relayProof,
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
    const previousPosts = await fetchAlephBootstrapPosts({
      apiHost: args.apiHost ?? DEFAULT_ALEPH_API_HOST,
      channel: args.channel,
      ref: args.ref,
      postType: args.postType,
      fetch: args.fetch as typeof fetch,
    });

    forgottenHashes = previousPosts
      .filter(
        (post) =>
          post.address?.toLowerCase() === args.sender.toLowerCase() &&
          post.content?.registrationId === args.registrationId &&
          (post.itemHash ?? post.hash) != null &&
          (post.itemHash ?? post.hash) !== unsigned.item_hash,
      )
      .map((post) => post.itemHash ?? post.hash ?? "")
      .filter(Boolean);

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
    publishedBrowserMultiaddrs: content.content?.browserMultiaddrs ?? [],
    forgottenHashes,
    forgetResult,
  };
}
