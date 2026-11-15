import test from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { privateKeyFromProtobuf } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";

import {
  assertOwnerSignature,
  configureBody,
  configurePortsFromMapping,
  generateRelayKeys,
  isAwaitingConfiguration,
  ownerAuthorizationMessage,
  ownerAuthorizationPayload,
} from "../src/relay-reconfigure.ts";
import { signRelayBootstrapAuthorization } from "../../aleph-bootstrap/src/index.ts";

const INSTANCE = "c29417ebe1fbc75c61676d940202b44176a3f82e5d70b1b3fc7be24cba80fae4";

// The mapping NodeCity3 reported for c294 after it came back blank on 2026-11-15.
const MAPPED_PORTS = {
  "22": { host: 33757, tcp: true, udp: false },
  "80": { host: 33758, tcp: true, udp: false },
  "443": { host: 33759, tcp: true, udp: false },
  "9090": { host: 33760, tcp: true, udp: false },
  "9091": { host: 33761, tcp: true, udp: false },
  "9092": { host: 33762, tcp: true, udp: false },
  "9093": { host: 33763, tcp: false, udp: true },
  "9094": { host: 33764, tcp: false, udp: true },
};

test("configure ports come from the CRN's current mapping", () => {
  assert.deepEqual(configurePortsFromMapping("orbitdb-relay", MAPPED_PORTS), {
    tcp_port: 33761,
    ws_port: 33762,
    metrics_port: 33760,
    webrtc_port: 33763,
    quic_port: 33764,
  });
  assert.throws(
    () => configurePortsFromMapping("orbitdb-relay", { "9091": { host: 1 } }),
    /guest port 9092/,
  );
});

test("only a guest that waits for its configuration counts as blank", () => {
  assert.equal(
    isAwaitingConfiguration({ status: "waiting-for-port-mapping", ready: false, metadata_ready: false }),
    true,
  );
  assert.equal(isAwaitingConfiguration({ status: "waiting-for-port-mapping", ready: true }), false);
  assert.equal(isAwaitingConfiguration(null), false);
});

test("generated keys yield the peer ID and publisher address they report", async () => {
  const keys = await generateRelayKeys();
  const identity = privateKeyFromProtobuf(Buffer.from(keys.libp2pIdentityHex, "hex"));
  assert.equal(peerIdFromPrivateKey(identity).toString(), keys.peerId);
  assert.equal(new Wallet(keys.publisherPrivateKey).address, keys.publisherAddress);
});

test("the message to sign is the one aleph-bootstrap signs, and the signature is checked", async () => {
  const owner = Wallet.createRandom();
  const keys = await generateRelayKeys();
  const payload = ownerAuthorizationPayload({
    ownerAddress: owner.address,
    keys,
    profile: "orbitdb-relay",
    instanceName: "orbitdb-relay",
    instanceItemHash: INSTANCE,
    issuedAt: 1794743425554,
  });
  assert.equal(payload.registrationId, `relay:orbitdb-relay:orbitdb-relay:${INSTANCE}`);

  let signedByLibrary = "";
  await signRelayBootstrapAuthorization({
    ...payload,
    signer: async (_address: string, serialized: string) => {
      signedByLibrary = serialized;
      return owner.signMessage(serialized);
    },
  });
  const message = ownerAuthorizationMessage(payload);
  assert.equal(message, signedByLibrary);

  const signature = await owner.signMessage(message);
  assertOwnerSignature(message, signature, owner.address);
  const strangerSignature = await Wallet.createRandom().signMessage(message);
  assert.throws(
    () => assertOwnerSignature(message, strangerSignature, owner.address),
    /not from the owner/,
  );

  const body = configureBody({
    hostIpv4: "37.114.50.44",
    ports: configurePortsFromMapping("orbitdb-relay", MAPPED_PORTS),
    proxyUrl: "https://secret-pass-wife-sentence.2n6.me",
    keys,
    payload,
    signature,
  });
  assert.equal(body.public_ipv4, "37.114.50.44");
  assert.equal(body.tcp_port, 33761);
  assert.equal(body.proxy_url, "https://secret-pass-wife-sentence.2n6.me");
  assert.equal("public_ipv6" in body, false);
  const authorization = JSON.parse(Buffer.from(String(body.bootstrap_owner_authorization_b64), "base64").toString());
  assert.deepEqual(authorization, { scheme: "personal_sign", payload, signature });
});
