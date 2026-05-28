import {
  createRelayBootstrapPost,
  DEFAULT_ALEPH_API_HOST,
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

export interface RelayBootstrapPublicationResult {
  status: "published" | "skipped";
  reason?: string;
  itemHash?: string;
  message?: AlephBroadcastMessage;
  response?: AlephBroadcastResponse;
  httpStatus?: number;
  publishedMultiaddrs?: string[];
  publishedBrowserMultiaddrs?: string[];
}

export async function publishRelayBootstrapRegistration(args: {
  sender: string;
  signer: MessageSigner;
  hasher: MessageHasher;
  fetch: JsonFetchLike;
  peerId: string;
  multiaddrs: string[];
  browserMultiaddrs?: string[];
  apiHost?: string;
  channel?: string;
  ref?: string;
  postType?: string;
  profile?: string;
  version?: string;
  sync?: boolean;
  now?: number;
}): Promise<RelayBootstrapPublicationResult> {
  const unsigned = await createRelayBootstrapPost({
    sender: args.sender,
    peerId: args.peerId,
    multiaddrs: args.multiaddrs,
    browserMultiaddrs: args.browserMultiaddrs,
    channel: args.channel,
    ref: args.ref,
    postType: args.postType,
    profile: args.profile,
    version: args.version,
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

  return {
    status: "published",
    itemHash: unsigned.item_hash,
    message,
    response,
    httpStatus,
    publishedMultiaddrs: content.content?.multiaddrs ?? [],
    publishedBrowserMultiaddrs: content.content?.browserMultiaddrs ?? [],
  };
}
