import { createHmac } from "node:crypto";

const SECP256K1_CURVE_ORDER =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

function hexToBytes(value: string): Uint8Array {
  const normalized = value.trim().replace(/^0x/i, "");
  if (normalized.length === 0 || normalized.length % 2 !== 0) {
    throw new Error("Expected an even-length hex string.");
  }
  if (!/^[0-9a-f]+$/i.test(normalized)) {
    throw new Error("Expected a valid hex string.");
  }
  return Uint8Array.from(Buffer.from(normalized, "hex"));
}

function normalizeToSecp256k1PrivateKey(bytes: Uint8Array): string {
  let scalar = 0n;
  for (const byte of bytes) {
    scalar = (scalar << 8n) + BigInt(byte);
  }
  const normalized = (scalar % (SECP256K1_CURVE_ORDER - 1n)) + 1n;
  return `0x${normalized.toString(16).padStart(64, "0")}`;
}

export function deriveBootstrapPublisherPrivateKey(args: {
  sourcePrivateKey: string;
  profile: string;
}): string {
  const sourceBytes = hexToBytes(args.sourcePrivateKey);
  const info = Buffer.from(`le-space/bootstrap-publisher/v1:${args.profile}`);
  const digest = createHmac("sha256", Buffer.from(sourceBytes))
    .update(info)
    .digest();
  return normalizeToSecp256k1PrivateKey(new Uint8Array(digest));
}
