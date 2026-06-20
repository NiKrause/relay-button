import type { MessageHasher, MessageSigner } from "@le-space/shared-types";
import {
  publishAggregateKey,
  type JsonFetchLike,
} from "../../core/src/index.ts";

export const ALEPH_DOMAIN_CHANNEL = "ALEPH-CLOUDSOLUTIONS";

export type DomainTargetKind = "ipfs" | "instance" | "program";

export interface DomainAggregateEntry {
  message_id: string;
  type: DomainTargetKind;
  programType: DomainTargetKind;
  options?: Record<string, unknown> | null;
  updated_at?: string;
}

export function normalizeDomainName(domain: string): string {
  const trimmed = domain.trim();
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed);
    return parsed.hostname.toLowerCase();
  } catch {
    return trimmed.replace(/^\/+|\/+$/g, "").toLowerCase();
  }
}

export async function attachAlephDomain(args: {
  sender: string;
  domain: string;
  itemHash: string;
  kind: DomainTargetKind;
  signer: MessageSigner;
  hasher: MessageHasher;
  fetch: JsonFetchLike;
  apiHost?: string;
  options?: Record<string, unknown> | null;
  updatedAt?: string;
}) {
  const domain = normalizeDomainName(args.domain);
  if (!domain) {
    throw new Error("Aleph domain attach requires a non-empty domain.");
  }

  const attachEntry: DomainAggregateEntry = {
    message_id: args.itemHash,
    type: args.kind,
    programType: args.kind,
  };
  attachEntry.options = args.options ?? null;
  if (args.updatedAt) {
    attachEntry.updated_at = args.updatedAt;
  }

  const attachPublication = await publishAggregateKey({
    sender: args.sender,
    key: "domains",
    content: { [domain]: attachEntry },
    signer: args.signer,
    hasher: args.hasher,
    fetch: args.fetch,
    channel: ALEPH_DOMAIN_CHANNEL,
    apiHost: args.apiHost,
  });

  if (attachPublication.status === "rejected") {
    throw new Error(
      `Aleph domain attach ${domain} was rejected: ${JSON.stringify(
        attachPublication.response ?? {},
      )}`,
    );
  }

  return {
    domain,
    itemHash: args.itemHash,
    aggregateItemHash: attachPublication.itemHash,
    aggregateStatus: attachPublication.status,
    httpStatus: attachPublication.httpStatus,
  };
}

export async function detachAlephDomain(args: {
  sender: string;
  domain: string;
  signer: MessageSigner;
  hasher: MessageHasher;
  fetch: JsonFetchLike;
  apiHost?: string;
}) {
  const domain = normalizeDomainName(args.domain);
  if (!domain) {
    throw new Error("Aleph domain detach requires a non-empty domain.");
  }

  const detachPublication = await publishAggregateKey({
    sender: args.sender,
    key: "domains",
    content: { [domain]: null },
    signer: args.signer,
    hasher: args.hasher,
    fetch: args.fetch,
    channel: ALEPH_DOMAIN_CHANNEL,
    apiHost: args.apiHost,
  });

  if (detachPublication.status === "rejected") {
    throw new Error(
      `Aleph domain detach ${domain} was rejected: ${JSON.stringify(
        detachPublication.response ?? {},
      )}`,
    );
  }

  return {
    domain,
    aggregateItemHash: detachPublication.itemHash,
    aggregateStatus: detachPublication.status,
    httpStatus: detachPublication.httpStatus,
  };
}
