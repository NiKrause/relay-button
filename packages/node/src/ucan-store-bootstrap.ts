import { hkdfSync } from "node:crypto";

import { delegate } from "@ucanto/core";
import { archive } from "@ucanto/core/delegation";
import { Absentee } from "@ucanto/principal";
import * as Ed25519 from "@ucanto/principal/ed25519";

import type { UcanStoreBootstrapPackage } from "@le-space/shared-types";
import { validateUcanStoreBootstrapPackage } from "@le-space/shared-types";

import { optionalEnv, requiredEnv } from "./env.ts";
import { createPrivateKeyIdentity } from "./signer.ts";

const DERIVE_MODE = "derive-from-aleph-private-key";
const DEFAULT_ALLOWED_CAPABILITIES = [
  "space/blob/add",
  "space/blob/list",
  "space/index/add",
  "space/index/list",
  "filecoin/offer",
  "upload/add",
  "upload/list",
  "store/add",
];
const DEFAULT_USER_DELEGATION_EXPIRATION_SECONDS = 31_536_000;
const DEFAULT_MAX_DELEGATION_EXPIRATION_SECONDS = 315_360_000;
const DEFAULT_SALT = "ucan-store/bootstrap/admin-ed25519/v1";
const DEFAULT_CONTEXT = "relay-button/ucan-store";

type DelegationProof = Parameters<typeof archive>[0];
type ServiceDid = Parameters<typeof Absentee.from>[0]["id"];
type DelegationCapabilities = Parameters<typeof delegate>[0]["capabilities"];

export type UcanStoreBootstrapDerivationMode = typeof DERIVE_MODE;

export interface DerivedUcanStoreBootstrapOptions {
  alephPrivateKey: string;
  operatorAddress?: string;
  serviceDid: string;
  serviceOrigin: string;
  pwaOrigin: string;
  allowedCapabilities?: string[];
  defaultUserDelegationExpiration?: number | null;
  maxUserDelegationExpiration?: number | null;
  derivationContext?: string;
  derivationSalt?: string;
  spaceDidMode?: "admin" | "derived";
}

function normalizeHexPrivateKey(value: string): Uint8Array {
  const normalized = value.trim().replace(/^0x/u, "");
  if (!/^[a-fA-F0-9]{64}$/u.test(normalized)) {
    throw new Error(
      "ALEPH_VM_PRIVATE_KEY must be a 32-byte hex private key for UCAN bootstrap derivation.",
    );
  }
  return Uint8Array.from(Buffer.from(normalized, "hex"));
}

function hkdfSeed(args: {
  privateKeyBytes: Uint8Array;
  salt: string;
  info: string;
}): Uint8Array {
  const derived = hkdfSync(
    "sha256",
    args.privateKeyBytes,
    Buffer.from(args.salt, "utf8"),
    Buffer.from(args.info, "utf8"),
    32,
  );
  return new Uint8Array(derived);
}

function parseCapabilityList(value: string): string[] {
  return value
    .split(/[\n,]/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseOptionalSeconds(value: string): number | null | undefined {
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.toLowerCase() === "null") return null;
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      "UCAN store delegation expiration values must be non-negative integer seconds or null.",
    );
  }
  return parsed;
}

function compactContextPart(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function derivationInfo(args: {
  context: string;
  serviceDid: string;
  serviceOrigin: string;
  pwaOrigin: string;
  role: "admin" | "space";
}): string {
  return [
    compactContextPart(args.context),
    `role=${args.role}`,
    `serviceDid=${compactContextPart(args.serviceDid)}`,
    `serviceOrigin=${compactContextPart(args.serviceOrigin)}`,
    `pwaOrigin=${compactContextPart(args.pwaOrigin)}`,
  ].join("|");
}

function normalizeDid(value: string, label: string): ServiceDid {
  const normalized = value.trim();
  if (!/^did:[^:]+:.+/u.test(normalized)) {
    throw new Error(`${label} must be a DID string.`);
  }
  return normalized as ServiceDid;
}

function createDelegationCapabilities(
  spaceDid: ServiceDid,
  allowedCapabilities: string[],
): DelegationCapabilities {
  return allowedCapabilities.map((capability) => ({
    with: spaceDid,
    can: capability,
  })) as DelegationCapabilities;
}

async function exportDelegationProof(
  delegation: DelegationProof,
): Promise<string> {
  const result = await archive(delegation);
  if (!result.ok) {
    throw result.error;
  }
  return `m${Buffer.from(result.ok).toString("base64")}`;
}

export async function deriveUcanStoreBootstrapPackage(
  options: DerivedUcanStoreBootstrapOptions,
): Promise<UcanStoreBootstrapPackage> {
  const privateKeyBytes = normalizeHexPrivateKey(options.alephPrivateKey);
  const derivationContext =
    options.derivationContext?.trim() || DEFAULT_CONTEXT;
  const derivationSalt = options.derivationSalt?.trim() || DEFAULT_SALT;

  const adminSigner = await Ed25519.derive(
    hkdfSeed({
      privateKeyBytes,
      salt: derivationSalt,
      info: derivationInfo({
        context: derivationContext,
        serviceDid: options.serviceDid,
        serviceOrigin: options.serviceOrigin,
        pwaOrigin: options.pwaOrigin,
        role: "admin",
      }),
    }),
  );

  const spaceDid =
    options.spaceDidMode === "derived"
      ? (
          await Ed25519.derive(
            hkdfSeed({
              privateKeyBytes,
              salt: derivationSalt,
              info: derivationInfo({
                context: derivationContext,
                serviceDid: options.serviceDid,
                serviceOrigin: options.serviceOrigin,
                pwaOrigin: options.pwaOrigin,
                role: "space",
              }),
            }),
          )
        ).did()
      : adminSigner.did();

  const serviceDid = normalizeDid(options.serviceDid, "serviceDid");
  const audience = Absentee.from({ id: serviceDid });
  const allowedCapabilities =
    options.allowedCapabilities && options.allowedCapabilities.length > 0
      ? options.allowedCapabilities
      : DEFAULT_ALLOWED_CAPABILITIES;

  const delegation = await delegate({
    issuer: adminSigner,
    audience,
    capabilities: createDelegationCapabilities(spaceDid, allowedCapabilities),
    expiration: Infinity,
  });

  const packageCandidate = {
    operatorAddress: options.operatorAddress,
    adminDid: adminSigner.did(),
    serviceDid: options.serviceDid,
    spaceDid,
    rootDelegationProof: await exportDelegationProof(delegation),
    allowedCapabilities,
    defaultUserDelegationExpiration:
      options.defaultUserDelegationExpiration ??
      DEFAULT_USER_DELEGATION_EXPIRATION_SECONDS,
    maxUserDelegationExpiration:
      options.maxUserDelegationExpiration ??
      DEFAULT_MAX_DELEGATION_EXPIRATION_SECONDS,
    pwaOrigin: options.pwaOrigin,
    serviceOrigin: options.serviceOrigin,
  };

  const validation = validateUcanStoreBootstrapPackage(packageCandidate);
  if (!validation.valid || !validation.bootstrapPackage) {
    throw new Error(
      `Derived UCAN store bootstrap package is invalid: ${validation.errors.join(" ")}`,
    );
  }

  return validation.bootstrapPackage;
}

export function shouldDeriveUcanStoreBootstrapPackage(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (optionalEnv("ALEPH_VM_UCAN_STORE_BOOTSTRAP_JSON", "", env).trim()) {
    return false;
  }
  return (
    optionalEnv("ALEPH_VM_UCAN_STORE_BOOTSTRAP_MODE", "", env)
      .trim()
      .toLowerCase() === DERIVE_MODE
  );
}

export async function deriveUcanStoreBootstrapPackageFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<UcanStoreBootstrapPackage> {
  const identity = await createPrivateKeyIdentity(
    requiredEnv("ALEPH_VM_PRIVATE_KEY", env),
  );
  const capabilities =
    parseCapabilityList(optionalEnv("ALEPH_VM_UCAN_STORE_ALLOWED_CAPABILITIES", "", env)) ??
    [];

  return deriveUcanStoreBootstrapPackage({
    alephPrivateKey: requiredEnv("ALEPH_VM_PRIVATE_KEY", env),
    operatorAddress: identity.address,
    serviceDid: requiredEnv("ALEPH_VM_UCAN_STORE_SERVICE_DID", env),
    serviceOrigin: requiredEnv("ALEPH_VM_UCAN_STORE_SERVICE_ORIGIN", env),
    pwaOrigin: requiredEnv("ALEPH_VM_UCAN_STORE_PWA_ORIGIN", env),
    allowedCapabilities:
      capabilities.length > 0 ? capabilities : DEFAULT_ALLOWED_CAPABILITIES,
    defaultUserDelegationExpiration: parseOptionalSeconds(
      optionalEnv(
        "ALEPH_VM_UCAN_STORE_DEFAULT_USER_DELEGATION_EXPIRATION",
        "",
        env,
      ),
    ),
    maxUserDelegationExpiration: parseOptionalSeconds(
      optionalEnv("ALEPH_VM_UCAN_STORE_MAX_DELEGATION_EXPIRATION", "", env),
    ),
    derivationContext: optionalEnv(
      "ALEPH_VM_UCAN_STORE_DERIVATION_CONTEXT",
      DEFAULT_CONTEXT,
      env,
    ),
    derivationSalt: optionalEnv(
      "ALEPH_VM_UCAN_STORE_DERIVATION_SALT",
      DEFAULT_SALT,
      env,
    ),
    spaceDidMode:
      optionalEnv("ALEPH_VM_UCAN_STORE_SPACE_DID_MODE", "admin", env).trim() ===
      "derived"
        ? "derived"
        : "admin",
  });
}
