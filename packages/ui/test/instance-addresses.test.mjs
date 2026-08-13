import assert from "node:assert/strict";
import test from "node:test";

import {
  createSponsorRelayController,
  parseInstanceAddressPayload,
} from "../dist/shared/index.js";

test("address parser reads orbitdb-relay's byTransport groups", () => {
  const parsed = parseInstanceAddressPayload({
    version: "0.10.3",
    peerId: "12D3KooWNkdvDw59Agjuhk6a3LTeqnsBgV4m5eivVjXdcgC7cYhn",
    byTransport: {
      webrtc: [],
      tcp: ["/ip4/203.0.113.10/tcp/9094/p2p/12D3KooWNkdv"],
      websocket: ["/dns4/relay.example.test/tcp/443/tls/ws/p2p/12D3KooWNkdv"],
    },
  });

  assert.equal(parsed.peerId, "12D3KooWNkdvDw59Agjuhk6a3LTeqnsBgV4m5eivVjXdcgC7cYhn");
  assert.equal(parsed.version, "0.10.3");
  // An empty transport is dropped rather than rendered as a heading with nothing
  // under it, which reads as "this transport is broken".
  assert.deepEqual(
    parsed.groups.map((group) => group.key),
    ["tcp", "websocket"],
  );
  assert.deepEqual(
    parsed.groups.map((group) => group.label),
    ["TCP", "WebSocket"],
  );
});

test("address parser reads uc-go-peer's describe keys", () => {
  const parsed = parseInstanceAddressPayload({
    peer_id: "16Uiu2HAmRkEHQpkriNg8Keg7UE5Vkc1x7FCuUbEd3Byp2MYnoAtF",
    direct_tcp_multiaddrs: ["/ip4/203.0.113.10/tcp/9095/p2p/16Uiu2HAm"],
    webrtc_direct_multiaddrs: [
      "/ip4/203.0.113.10/udp/9095/webrtc-direct/certhash/uEiTest/p2p/16Uiu2HAm",
    ],
    autotls_wss_multiaddrs: [],
    browser_bootstrap_multiaddrs: [
      "/ip4/203.0.113.10/udp/9095/webrtc-direct/certhash/uEiTest/p2p/16Uiu2HAm",
    ],
  });

  assert.equal(parsed.peerId, "16Uiu2HAmRkEHQpkriNg8Keg7UE5Vkc1x7FCuUbEd3Byp2MYnoAtF");
  assert.deepEqual(
    parsed.groups.map((group) => group.key),
    ["direct_tcp", "webrtc_direct", "browser_bootstrap"],
  );
  assert.deepEqual(
    parsed.groups.map((group) => group.label),
    ["Direct TCP", "WebRTC Direct", "Browser bootstrap"],
  );
});

test("address parser keeps the payload verbatim and ranks nothing", () => {
  const payload = {
    byTransport: { tcp: ["/ip4/203.0.113.10/tcp/9094/p2p/12D3KooWNkdv"] },
    // The relay's own idea of a "best" address is deliberately ignored: the card
    // shows what the relay reports and lets the consumer choose. See #93/#94,
    // where best.websocket pointed at a port nothing answers.
    best: { websocket: "/dns4/relay.example.test/tcp/62227/tls/ws/p2p/12D3" },
  };
  const parsed = parseInstanceAddressPayload(payload);

  assert.equal(parsed.payload, payload);
  assert.equal(
    parsed.groups.some((group) => group.key === "best"),
    false,
  );
});

test("address parser surfaces a ucan-store style pwa_env block", () => {
  const parsed = parseInstanceAddressPayload({
    pwa_env: {
      VITE_UPLOAD_SERVICE_URL: "https://upload.example.test",
      VITE_RECEIPTS_URL: "https://receipts.example.test",
      ignored: 42,
    },
  });

  assert.deepEqual(parsed.groups, []);
  assert.deepEqual(parsed.pwaEnv, {
    VITE_UPLOAD_SERVICE_URL: "https://upload.example.test",
    VITE_RECEIPTS_URL: "https://receipts.example.test",
  });
});

test("loading addresses for a deployment without a proxy says so plainly", async () => {
  const controller = createSponsorRelayController();

  await controller.loadInstanceAddresses("missing-item-hash");

  const record = controller.getState().instanceAddresses["missing-item-hash"];
  assert.equal(record.status, "unsupported");
  assert.deepEqual(record.groups, []);
  // The issue asks for an honest message rather than an empty list, which reads
  // as "this relay has no addresses".
  assert.match(record.error, /no HTTPS proxy hostname/);
});
