import test from "node:test";
import assert from "node:assert/strict";

import {
  configureUcanStore,
  configureOrbitdbRelaySetup,
  configureUcGoPeer,
  fetchUcGoPeerMetadata,
  notifyCrnAllocation,
  notifyCrnAllocationWithRetry,
  verifyUcGoPeerReachability,
  waitForSetupEndpoint,
} from "../src/guest.ts";

function jsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url: "https://example.com/final",
    async json() {
      return payload;
    },
  };
}

test("notifyCrnAllocation skips missing CRN URLs and confirms successful notifies", async () => {
  assert.equal(
    (
      await notifyCrnAllocation({
        crnUrl: "",
        itemHash: "instance-1",
        fetch: async () => jsonResponse({}),
      })
    ).status,
    "skipped",
  );

  const confirmed = await notifyCrnAllocation({
    crnUrl: "https://crn.example.com/",
    itemHash: "instance-1",
    fetch: async (url, init) => {
      assert.equal(
        String(url),
        "https://crn.example.com/control/allocation/notify",
      );
      assert.equal(init?.method, "POST");
      return jsonResponse({ ok: true });
    },
  });

  assert.equal(confirmed.status, "confirmed");
});

test("notifyCrnAllocationWithRetry retries known transient targeted-allocation responses and emits progress", async () => {
  let attempts = 0;
  const stages: string[] = [];

  const result = await notifyCrnAllocationWithRetry({
    crnUrl: "https://crn.example.com/",
    itemHash: "instance-1",
    delayMs: 1,
    sleep: async () => undefined,
    onProgress: (event) => {
      stages.push(event.stage);
    },
    fetch: async () => {
      attempts += 1;
      if (attempts < 3) {
        return {
          ok: false,
          status: 503,
          async text() {
            return "node hash not yet discovered";
          },
          async json() {
            return { error: "node hash not yet discovered" };
          },
        };
      }

      return jsonResponse({ ok: true });
    },
  });

  assert.equal(result.status, "confirmed");
  assert.equal(attempts, 3);
  assert.deepEqual(stages, ["notifying-crn", "notifying-crn", "notifying-crn"]);
});

test("waitForSetupEndpoint polls the setup health endpoint until reachable", async () => {
  let attempts = 0;
  const result = await waitForSetupEndpoint({
    hostIpv4: "203.0.113.5",
    setupPort: 30080,
    attempts: 3,
    delayMs: 1,
    sleep: async () => undefined,
    fetch: async () => {
      attempts += 1;
      return jsonResponse({}, attempts >= 2 ? 200 : 503);
    },
  });

  assert.equal(result.ok, true);
});

test("configureUcGoPeer posts the expected payload to the guest", async () => {
  let body = "";
  const result = await configureUcGoPeer({
    hostIpv4: "203.0.113.5",
    publicIpv6: "2001:db8::5",
    setupPort: 30080,
    tcpPort: 32095,
    wsPort: 32097,
    udpPort: 32095,
    quicPort: 32095,
    webrtcPort: 32095,
    proxyUrl: "https://relay.example.com",
    bootstrapPublisherPrivateKey: "0xpublisher",
    bootstrapPublisherLibp2pIdentityBase64: "ZmFrZS1saWJwMnAtaWRlbnRpdHk=",
    bootstrapOwnerAuthorizationBase64: "eyJhdXRoIjp0cnVlfQ==",
    bootstrapRegistrationId: "relay:uc-go-peer:demo",
    noStart: true,
    fetch: async (_url, init) => {
      body = String(init?.body ?? "");
      return jsonResponse({ status: "configured" });
    },
  });

  assert.deepEqual(result, { status: "configured" });
  assert.match(body, /"public_ipv4":"203\.0\.113\.5"/);
  assert.match(body, /"proxy_url":"https:\/\/relay\.example\.com"/);
  assert.match(body, /"bootstrap_publisher_private_key":"0xpublisher"/);
  assert.match(
    body,
    /"bootstrap_publisher_libp2p_identity_b64":"ZmFrZS1saWJwMnAtaWRlbnRpdHk="/,
  );
  // The setup endpoint is plain HTTP, so the owner's private key must never
  // be part of the payload — only the signed authorization is.
  assert.doesNotMatch(body, /bootstrap_owner_private_key/);
  assert.match(body, /"bootstrap_owner_authorization_b64":"eyJhdXRoIjp0cnVlfQ=="/);
  assert.match(body, /"bootstrap_registration_id":"relay:uc-go-peer:demo"/);
  assert.match(body, /"no_start":true/);
});

test("configureOrbitdbRelaySetup posts bootstrap key material to the guest", async () => {
  let body = "";
  const result = await configureOrbitdbRelaySetup({
    hostIpv4: "203.0.113.8",
    publicIpv6: "2001:db8::8",
    setupPort: 28080,
    tcpPort: 32091,
    wsPort: 32443,
    proxyUrl: "https://relay.example.com",
    metricsPort: 32090,
    metricsHttpsPort: 32443,
    webrtcPort: 32093,
    quicPort: 32094,
    bootstrapPublisherPrivateKey: "0xpublisher",
    bootstrapPublisherLibp2pIdentityHex: "deadbeef",
    bootstrapOwnerAuthorizationBase64: "eyJhdXRoIjp0cnVlfQ==",
    bootstrapRegistrationId: "relay:orbitdb-relay:demo",
    noStart: true,
    fetch: async (_url, init) => {
      body = String(init?.body ?? "");
      return jsonResponse({ status: "configured" });
    },
  });

  assert.deepEqual(result, { status: "configured" });
  assert.match(body, /"public_ipv4":"203\.0\.113\.8"/);
  assert.match(body, /"tcp_port":32091/);
  assert.match(body, /"ws_port":32443/);
  assert.match(body, /"bootstrap_publisher_private_key":"0xpublisher"/);
  assert.match(body, /"bootstrap_publisher_libp2p_identity_hex":"deadbeef"/);
  // The setup endpoint is plain HTTP, so the owner's private key must never
  // be part of the payload — only the signed authorization is.
  assert.doesNotMatch(body, /bootstrap_owner_private_key/);
  assert.match(body, /"bootstrap_owner_authorization_b64":"eyJhdXRoIjp0cnVlfQ=="/);
  assert.match(body, /"bootstrap_registration_id":"relay:orbitdb-relay:demo"/);
  assert.match(body, /"no_start":true/);
});

test("configureUcanStore posts the expected payload to the guest", async () => {
  let body = "";
  const result = await configureUcanStore({
    hostIpv4: "203.0.113.9",
    publicIpv6: "2001:db8::9",
    setupPort: 28080,
    proxyUrl: "https://upload.example.com",
    serviceDid: "did:web:upload.example.com",
    serviceOrigin: "https://upload.example.com",
    publicStorageOrigin: "https://reserved-proxy.example.2n6.me",
    webauthnOrigin: "https://upload.example.com",
    webauthnOriginFallbacks: "https://alt-upload.example.com",
    adminDid: "did:key:zAdmin",
    adminApiToken: "admin-secret",
    bootstrapPackage: {
      operatorAddress: "0x1234000000000000000000000000000000000000",
      adminDid: "did:key:zAdmin",
      serviceDid: "did:key:zService",
      spaceDid: "did:key:zSpace",
      rootDelegationProof: "uEgVjYW5wcm9vZg",
      allowedCapabilities: ["space/blob/add"],
      defaultUserDelegationExpiration: 86400,
      maxUserDelegationExpiration: 604800,
      pwaOrigin: "https://store.example.com",
      serviceOrigin: "https://upload.example.com",
    },
    noStart: true,
    fetch: async (_url, init) => {
      body = String(init?.body ?? "");
      return jsonResponse({ status: "configured" });
    },
  });

  assert.deepEqual(result, { status: "configured" });
  assert.match(body, /"public_ipv4":"203\.0\.113\.9"/);
  assert.match(body, /"public_ipv6":"2001:db8::9"/);
  assert.match(body, /"proxy_url":"https:\/\/upload\.example\.com"/);
  assert.match(body, /"service_did":"did:web:upload\.example\.com"/);
  assert.match(body, /"service_origin":"https:\/\/upload\.example\.com"/);
  assert.match(
    body,
    /"public_storage_origin":"https:\/\/reserved-proxy\.example\.2n6\.me"/,
  );
  assert.match(body, /"webauthn_origin":"https:\/\/upload\.example\.com"/);
  assert.match(
    body,
    /"webauthn_origin_fallbacks":"https:\/\/alt-upload\.example\.com"/,
  );
  assert.match(body, /"admin_did":"did:key:zAdmin"/);
  assert.match(body, /"admin_api_token":"admin-secret"/);
  assert.match(body, /"bootstrap_package":\{/);
  assert.match(body, /"serviceDid":"did:key:zService"/);
  assert.match(body, /"rootDelegationProof":"uEgVjYW5wcm9vZg"/);
  assert.match(body, /"no_start":true/);
});

test("fetchUcGoPeerMetadata waits until the guest reports ready metadata", async () => {
  let attempts = 0;
  const result = await fetchUcGoPeerMetadata({
    hostIpv4: "203.0.113.5",
    setupPort: 30080,
    attempts: 3,
    delayMs: 1,
    sleep: async () => undefined,
    fetch: async () => {
      attempts += 1;
      return jsonResponse(
        attempts >= 2
          ? {
              status: "ready",
              metadata: { peer_id: "12D3KooW", probe_multiaddrs: [] },
            }
          : { status: "configuring" },
      );
    },
  });

  assert.deepEqual(result, {
    status: "ready",
    metadata: { peer_id: "12D3KooW", probe_multiaddrs: [] },
  });
});

test("fetchUcGoPeerMetadata can keep polling until metadata is complete", async () => {
  let attempts = 0;
  const result = await fetchUcGoPeerMetadata({
    hostIpv4: "203.0.113.5",
    setupPort: 30080,
    attempts: 3,
    delayMs: 1,
    sleep: async () => undefined,
    isReady: ({ payload, ok }) => {
      if (!ok || !payload || typeof payload !== "object") return false;
      const metadata =
        (payload as { metadata?: unknown }).metadata &&
        typeof (payload as { metadata?: unknown }).metadata === "object"
          ? ((payload as { metadata: Record<string, unknown> }).metadata)
          : null;
      return Boolean(
        typeof metadata?.peer_id === "string" &&
          Array.isArray(metadata?.probe_multiaddrs) &&
          metadata.probe_multiaddrs.length > 0,
      );
    },
    fetch: async () => {
      attempts += 1;
      if (attempts === 1) {
        return jsonResponse({
          status: "ready",
          metadata: { peer_id: "12D3KooW", probe_multiaddrs: [] },
        });
      }
      return jsonResponse({
        status: "ready",
        metadata: {
          peer_id: "12D3KooW",
          probe_multiaddrs: ["/dns4/relay.example.com/tcp/443/tls/ws/p2p/12D3KooW"],
        },
      });
    },
  });

  assert.deepEqual(result, {
    status: "ready",
    metadata: {
      peer_id: "12D3KooW",
      probe_multiaddrs: ["/dns4/relay.example.com/tcp/443/tls/ws/p2p/12D3KooW"],
    },
  });
  assert.equal(attempts, 2);
});

test("fetchUcGoPeerMetadata retries transient request errors before succeeding", async () => {
  let attempts = 0;
  const result = await fetchUcGoPeerMetadata({
    hostIpv4: "203.0.113.5",
    setupPort: 30080,
    attempts: 3,
    delayMs: 1,
    sleep: async () => undefined,
    fetch: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("temporary network error");
      }
      return jsonResponse({
        status: "ready",
        metadata: { peer_id: "12D3KooW", probe_multiaddrs: [] },
      });
    },
  });

  assert.deepEqual(result, {
    status: "ready",
    metadata: { peer_id: "12D3KooW", probe_multiaddrs: [] },
  });
  assert.equal(attempts, 2);
});

test("verifyUcGoPeerReachability checks mapped TCP ports, proxy HTTP, proxy TCP, and UDP notes", async () => {
  const result = await verifyUcGoPeerReachability({
    hostIpv4: "203.0.113.5",
    mappedPorts: {
      "80": { host: 30080, tcp: true },
      "443": { host: 30443, tcp: true },
      "9095": { host: 32095, tcp: true, udp: true },
    },
    proxyUrl: "https://relay.example.com",
    skipInternalPorts: ["80"],
    fetch: async () => jsonResponse({}),
    httpProbe: async () => ({
      ok: true,
      status: 200,
      url: "https://relay.example.com",
    }),
    tcpProbe: async (_host, port) => ({
      ok: port !== 443,
      error: port === 443 ? "closed" : undefined,
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.checks["https:proxy"].ok, true);
  assert.equal(result.checks["tcp:443"].ok, true);
  assert.equal(result.checks["tcp:9095"].ok, true);
  assert.equal(result.checks["tcp:proxy-443"].ok, false);
});
