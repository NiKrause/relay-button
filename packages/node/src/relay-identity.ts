import { getBytes } from "ethers";
import { privateKeyFromRaw, privateKeyToProtobuf } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";

export interface DerivedRelayIdentity {
  peerId: string;
  protobuf: Uint8Array;
  protobufBase64: string;
}

export function deriveLibp2pSecp256k1IdentityFromEvmKey(
  privateKeyHex: string,
): DerivedRelayIdentity {
  const raw = getBytes(privateKeyHex);
  if (raw.byteLength !== 32) {
    throw new Error(
      `Expected a 32-byte secp256k1 private key, received ${raw.byteLength} bytes.`,
    );
  }

  const privateKey = privateKeyFromRaw(raw);
  if (privateKey.type !== "secp256k1") {
    throw new Error(
      `Expected a secp256k1 libp2p private key, received ${privateKey.type}.`,
    );
  }

  const peerId = peerIdFromPrivateKey(privateKey).toString();
  const protobuf = privateKeyToProtobuf(privateKey);

  return {
    peerId,
    protobuf,
    protobufBase64: Buffer.from(protobuf).toString("base64"),
  };
}
