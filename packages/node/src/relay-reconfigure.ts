// Bringing back a relay whose execution Aleph tore down (relay-button#233).
//
// When a paying account runs dry, or a scheduler moves an instance, aleph-vm
// retires the execution as GONE and, by default, purges its disk. When the
// instance comes back it is rebuilt from the parent image: no ready file, no
// identity, new mapped ports. A relay deployed with the push handoff then
// waits on port 80 for a `POST /configure` that nobody sends.
//
// This module holds the pure parts of the manual recovery; the network steps
// live in `scripts/aleph-relay-reconfigure.mjs`. Keys are generated here so
// that the peer ID and publisher address are known *before* the guest sees
// them: the owner authorization binds both, and the owner signs it once.
import { Wallet, verifyMessage } from "ethers";
import { generateKeyPair, privateKeyToProtobuf } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";

import { createRelayBootstrapRegistrationId } from "../../core/src/index.ts";

/** Guest ports per profile, by the field name `/configure` expects. */
export const RELAY_RECONFIGURE_PROFILES = {
  "orbitdb-relay": {
    setup: "80",
    required: { tcp_port: "9091", ws_port: "9092" },
    optional: { metrics_port: "9090", webrtc_port: "9093", quic_port: "9094" },
  },
} as const;

export type RelayReconfigureProfile = keyof typeof RELAY_RECONFIGURE_PROFILES;

export interface MappedPort {
  host?: number;
  tcp?: boolean;
  udp?: boolean;
}

export function assertReconfigurableProfile(profile: string): RelayReconfigureProfile {
  if (!(profile in RELAY_RECONFIGURE_PROFILES)) {
    throw new Error(
      `relay-reconfigure supports ${Object.keys(RELAY_RECONFIGURE_PROFILES).join(", ")}, not ${profile}.`,
    );
  }
  return profile as RelayReconfigureProfile;
}

/** The host port the CRN maps to `guestPort`, or null. */
export function hostPortFor(mappedPorts: Record<string, MappedPort> | null | undefined, guestPort: string): number | null {
  const host = mappedPorts?.[guestPort]?.host;
  return Number.isInteger(host) && Number(host) > 0 ? Number(host) : null;
}

/**
 * The `/configure` port fields from the CRN's current mapping. The ports a
 * relay announced before the teardown are gone; only the mapping the CRN
 * reports now is right.
 */
export function configurePortsFromMapping(
  profile: RelayReconfigureProfile,
  mappedPorts: Record<string, MappedPort> | null | undefined,
): Record<string, number> {
  const spec = RELAY_RECONFIGURE_PROFILES[profile];
  const ports: Record<string, number> = {};
  for (const [field, guestPort] of Object.entries(spec.required)) {
    const host = hostPortFor(mappedPorts, guestPort);
    if (host == null) {
      throw new Error(`The CRN maps no host port to guest port ${guestPort} (${field}).`);
    }
    ports[field] = host;
  }
  for (const [field, guestPort] of Object.entries(spec.optional)) {
    const host = hostPortFor(mappedPorts, guestPort);
    if (host != null) ports[field] = host;
  }
  return ports;
}

/** Whether the guest's setup server is still waiting for its configuration. */
export function isAwaitingConfiguration(status: unknown): boolean {
  const body = status as { status?: unknown; ready?: unknown } | null;
  return body?.status === "waiting-for-port-mapping" && body?.ready === false;
}

export interface RelayKeys {
  publisherPrivateKey: string;
  publisherAddress: string;
  libp2pIdentityHex: string;
  peerId: string;
}

/** A fresh publisher key and libp2p identity for the guest. */
export async function generateRelayKeys(): Promise<RelayKeys> {
  const publisher = Wallet.createRandom();
  const identity = await generateKeyPair("Ed25519");
  return {
    publisherPrivateKey: publisher.privateKey,
    publisherAddress: publisher.address,
    libp2pIdentityHex: Buffer.from(privateKeyToProtobuf(identity)).toString("hex"),
    peerId: peerIdFromPrivateKey(identity).toString(),
  };
}

export interface OwnerAuthorizationPayload {
  ownerAddress: string;
  publisherAddress: string;
  peerId: string;
  registrationId: string;
  profile: string;
  instanceItemHash: string;
  issuedAt: number;
}

export function ownerAuthorizationPayload(args: {
  ownerAddress: string;
  keys: Pick<RelayKeys, "publisherAddress" | "peerId">;
  profile: string;
  instanceName: string | null | undefined;
  instanceItemHash: string;
  issuedAt?: number;
}): OwnerAuthorizationPayload {
  return {
    ownerAddress: args.ownerAddress,
    publisherAddress: args.keys.publisherAddress,
    peerId: args.keys.peerId,
    registrationId: createRelayBootstrapRegistrationId(
      args.profile,
      args.instanceName,
      args.instanceItemHash,
    ),
    profile: args.profile,
    instanceItemHash: args.instanceItemHash,
    issuedAt: args.issuedAt ?? Date.now(),
  };
}

/**
 * The exact text the owner signs with `personal_sign`. Same key order as
 * `signRelayBootstrapAuthorization` in @le-space/aleph-bootstrap (version and
 * expiresAt are left out, as the guest's own registrations leave them out).
 */
export function ownerAuthorizationMessage(payload: OwnerAuthorizationPayload): string {
  return JSON.stringify({
    ownerAddress: payload.ownerAddress,
    publisherAddress: payload.publisherAddress,
    peerId: payload.peerId,
    registrationId: payload.registrationId,
    profile: payload.profile,
    instanceItemHash: payload.instanceItemHash,
    issuedAt: payload.issuedAt,
  });
}

/** Throws unless `signature` over `message` recovers to `ownerAddress`. */
export function assertOwnerSignature(message: string, signature: string, ownerAddress: string): void {
  const recovered = verifyMessage(message, signature.trim());
  if (recovered.toLowerCase() !== ownerAddress.toLowerCase()) {
    throw new Error(`The signature is from ${recovered}, not from the owner ${ownerAddress}.`);
  }
}

/** The `POST /configure` body. The IPv6 address is left out on purpose (#227). */
export function configureBody(args: {
  hostIpv4: string;
  ports: Record<string, number>;
  proxyUrl: string | null;
  keys: Pick<RelayKeys, "publisherPrivateKey" | "libp2pIdentityHex">;
  payload: OwnerAuthorizationPayload;
  signature: string;
}): Record<string, unknown> {
  const authorization = {
    scheme: "personal_sign",
    payload: args.payload,
    signature: args.signature.trim(),
  };
  return {
    public_ipv4: args.hostIpv4,
    ...args.ports,
    ...(args.proxyUrl ? { proxy_url: args.proxyUrl } : {}),
    bootstrap_publisher_private_key: args.keys.publisherPrivateKey,
    bootstrap_publisher_libp2p_identity_hex: args.keys.libp2pIdentityHex,
    bootstrap_owner_authorization_b64: Buffer.from(JSON.stringify(authorization)).toString("base64"),
    bootstrap_registration_id: args.payload.registrationId,
  };
}
