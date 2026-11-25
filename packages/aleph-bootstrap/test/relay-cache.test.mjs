import test from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";

import {
  alephBootstrapDiscovery,
  createAlephRelayCache,
  discoverAlephBootstrapMultiaddrsCached,
  fetchAlephBootstrapPosts,
  memoryRelayCacheStorage,
  refreshAlephRelayCache,
  relayCacheKey,
} from "../dist/index.js";

// #266: relays remembered between starts, refreshed from Aleph without delaying one.

const PEER_A = "12D3KooWMEf6tc9RuJghTGPgbfBQfdjTWApppnabrbHz4ketNWUk";
const PEER_B = "12D3KooWRWuptRiwfJmpQgtj3A5xZ36GFkHQSm2dzkwhDeGLvbyT";
const PEER_C = "12D3KooWRgvrnXinpeFZc6gF3rXoSUp94xfygni9MrSzB1LBuV65";
const addrOf = (peerId, host = "relay-a.example.com") => `/dns4/${host}/tcp/443/tls/ws/p2p/${peerId}`;

const owner = privateKeyToAccount("0x1111111111111111111111111111111111111111111111111111111111111111");
const publisher = privateKeyToAccount("0x2222222222222222222222222222222222222222222222222222222222222222");

/** A dual-key registration as a relay publishes it, signed by owner and publisher. */
async function registration({ peerId, addr, registrationId = "relay:orbitdb-relay:test", updatedAt = Date.now() }) {
  const authorizationPayload = {
    ownerAddress: owner.address,
    publisherAddress: publisher.address,
    peerId,
    registrationId,
    profile: "orbitdb-relay",
    issuedAt: updatedAt - 60_000,
  };
  const proofPayload = {
    peerId,
    multiaddrs: [addr],
    registrationId,
    profile: "orbitdb-relay",
    version: null,
    updatedAt,
  };
  return {
    peerId,
    multiaddrs: [addr],
    browserMultiaddrs: null,
    registrationId,
    profile: "orbitdb-relay",
    version: null,
    ownerAddress: owner.address,
    publisherAddress: publisher.address,
    authorization: {
      scheme: "personal_sign",
      payload: authorizationPayload,
      signature: await owner.signMessage({ message: JSON.stringify(authorizationPayload) }),
    },
    relayProof: {
      scheme: "personal_sign",
      payload: proofPayload,
      signature: await publisher.signMessage({ message: JSON.stringify(proofPayload) }),
    },
    updatedAt,
  };
}

/** A fetch for the posts endpoint that counts its calls; `contents` may change between calls. */
function registryFetch(source) {
  const calls = { count: 0 };
  const fetchImpl = async (input) => {
    calls.count += 1;
    const url = new URL(input);
    assert.equal(url.pathname, "/api/v0/posts.json");
    const contents = typeof source === "function" ? await source() : source;
    const posts = contents.map((content, index) => ({
      chain: "ETH",
      item_hash: `item-${index}-${content.peerId}`,
      sender: publisher.address,
      type: "relay-bootstrap-v2",
      channel: "simple-todo",
      confirmed: true,
      content,
      item_content: JSON.stringify({
        type: "relay-bootstrap-v2",
        address: publisher.address,
        ref: "simple-todo-bootstrap",
        content,
        time: content.updatedAt / 1000,
      }),
      item_type: "inline",
      time: content.updatedAt / 1000,
      hash: `item-${index}-${content.peerId}`,
      address: publisher.address,
      ref: "simple-todo-bootstrap",
    }));
    return new Response(JSON.stringify({ posts, pagination_page: 1, pagination_total: posts.length, pagination_per_page: 50 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch: fetchImpl, calls };
}

const failingFetch = async () => {
  throw new Error("Aleph unreachable");
};

/** Records exactly as discovery hands them over (normalized, signatures kept). */
async function recordsFor(contents) {
  return fetchAlephBootstrapPosts({ fetch: registryFetch(contents).fetch });
}

// --- the cache -------------------------------------------------------------

test("relayCacheKey keeps scopes apart and ignores the order of a list", () => {
  assert.notEqual(relayCacheKey({ profile: "orbitdb-relay" }), relayCacheKey({ profile: "uc-go-peer" }));
  assert.notEqual(relayCacheKey({ registrationId: "relay:a" }), relayCacheKey({}));
  assert.equal(
    relayCacheKey({ profile: ["b", "a"] }),
    relayCacheKey({ profile: ["a", "b"] }),
  );
});

test("the cache returns what it saved, and keeps it across instances on one storage", async () => {
  const storage = memoryRelayCacheStorage();
  const records = await recordsFor([await registration({ peerId: PEER_A, addr: addrOf(PEER_A) })]);
  await createAlephRelayCache({ storage, key: "k" }).save(records);

  const loaded = await createAlephRelayCache({ storage, key: "k" }).load();
  assert.deepEqual(loaded.map((record) => record.content.peerId), [PEER_A]);
});

test("the cache drops records past their age", async () => {
  const storage = memoryRelayCacheStorage();
  const updatedAt = Date.now() - 2 * 60 * 60 * 1000;
  const records = await recordsFor([await registration({ peerId: PEER_A, addr: addrOf(PEER_A), updatedAt })]);
  await createAlephRelayCache({ storage, key: "k" }).save(records);

  assert.equal((await createAlephRelayCache({ storage, key: "k", maxAgeMs: 60 * 60 * 1000 }).load()).length, 0);
  assert.equal((await createAlephRelayCache({ storage, key: "k" }).load()).length, 1);
});

test("the cache drops a relay after repeated failures and keeps it after a success", async () => {
  const storage = memoryRelayCacheStorage();
  const cache = createAlephRelayCache({ storage, key: "k", maxFailures: 2 });
  await cache.save(await recordsFor([await registration({ peerId: PEER_A, addr: addrOf(PEER_A) })]));

  await cache.recordFailure(PEER_A);
  assert.equal((await cache.load()).length, 1);
  await cache.recordSuccess(PEER_A);
  await cache.recordFailure(PEER_A);
  assert.equal((await cache.load()).length, 1, "a success starts the count over");
  await cache.recordFailure(PEER_A);
  assert.equal((await cache.load()).length, 0);
});

test("a record edited in storage is not trusted on load", async () => {
  const storage = memoryRelayCacheStorage();
  const cache = createAlephRelayCache({ storage, key: "k" });
  await cache.save(await recordsFor([await registration({ peerId: PEER_A, addr: addrOf(PEER_A) })]));

  const stored = JSON.parse(storage.getItem("k"));
  stored.records[0].content.multiaddrs = [addrOf(PEER_A, "attacker.example.com")];
  storage.setItem("k", JSON.stringify(stored));

  assert.equal((await cache.load()).length, 0);
});

test("corrupt storage reads as empty, and failing storage never throws", async () => {
  const corrupt = memoryRelayCacheStorage();
  corrupt.setItem("k", "{not json");
  assert.deepEqual(await createAlephRelayCache({ storage: corrupt, key: "k" }).load(), []);

  const broken = {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
    removeItem: () => {
      throw new Error("SecurityError");
    },
  };
  const cache = createAlephRelayCache({ storage: broken, key: "k" });
  await cache.save(await recordsFor([await registration({ peerId: PEER_A, addr: addrOf(PEER_A) })]));
  assert.deepEqual(await cache.load(), []);
  assert.equal(await cache.savedAt(), null);
  await cache.clear();
});

// --- cache-first discovery ----------------------------------------------------

test("with an empty cache, discovery returns nothing at once and fills the cache from Aleph", async () => {
  const cache = createAlephRelayCache({ storage: memoryRelayCacheStorage(), key: "k" });
  const registry = registryFetch([await registration({ peerId: PEER_A, addr: addrOf(PEER_A) })]);

  const result = await discoverAlephBootstrapMultiaddrsCached({ cache, fetch: registry.fetch });
  assert.deepEqual(result.addrs, []);
  assert.equal(result.fromCache, false);
  assert.ok(result.refreshed, "an empty cache is stale");

  const refreshed = await result.refreshed;
  assert.deepEqual(refreshed.addrs, [addrOf(PEER_A)]);
  assert.deepEqual(refreshed.added, [addrOf(PEER_A)]);
  assert.equal(registry.calls.count, 1);
  assert.equal((await cache.load()).length, 1);
});

test("a fresh cache is used without asking Aleph", async () => {
  const cache = createAlephRelayCache({ storage: memoryRelayCacheStorage(), key: "k" });
  await cache.save(await recordsFor([await registration({ peerId: PEER_A, addr: addrOf(PEER_A) })]));
  const registry = registryFetch([]);

  const result = await discoverAlephBootstrapMultiaddrsCached({ cache, fetch: registry.fetch });
  assert.deepEqual(result.addrs, [addrOf(PEER_A)]);
  assert.equal(result.fromCache, true);
  assert.equal(result.refreshed, null);
  assert.equal(registry.calls.count, 0);
});

test("a cache older than refreshAfterMs is used at once and refreshed behind it", async () => {
  const storage = memoryRelayCacheStorage();
  const saveTime = Date.now() - 2 * 60 * 60 * 1000;
  await createAlephRelayCache({ storage, key: "k", now: () => saveTime }).save(
    await recordsFor([await registration({ peerId: PEER_A, addr: addrOf(PEER_A) })]),
  );
  const cache = createAlephRelayCache({ storage, key: "k" });
  const registry = registryFetch([await registration({ peerId: PEER_A, addr: addrOf(PEER_A) })]);

  const result = await discoverAlephBootstrapMultiaddrsCached({ cache, fetch: registry.fetch, refreshAfterMs: 60 * 60 * 1000 });
  assert.deepEqual(result.addrs, [addrOf(PEER_A)]);
  assert.ok(result.refreshed);
  await result.refreshed;
  assert.equal(registry.calls.count, 1);
});

test("refresh 'always' returns the cache and reports what Aleph added and removed", async () => {
  const cache = createAlephRelayCache({ storage: memoryRelayCacheStorage(), key: "k" });
  await cache.save(await recordsFor([await registration({ peerId: PEER_A, addr: addrOf(PEER_A) })]));
  const registry = registryFetch([await registration({ peerId: PEER_B, addr: addrOf(PEER_B, "relay-b.example.com") })]);

  const result = await discoverAlephBootstrapMultiaddrsCached({ cache, fetch: registry.fetch, refresh: "always" });
  assert.deepEqual(result.addrs, [addrOf(PEER_A)]);
  const refreshed = await result.refreshed;
  assert.deepEqual(refreshed.added, [addrOf(PEER_B, "relay-b.example.com")]);
  assert.deepEqual(refreshed.removed, [addrOf(PEER_A)]);
  assert.deepEqual((await cache.load()).map((record) => record.content.peerId), [PEER_B]);
});

test("refresh 'never' does not ask Aleph even with an empty cache", async () => {
  const registry = registryFetch([await registration({ peerId: PEER_A, addr: addrOf(PEER_A) })]);
  const result = await discoverAlephBootstrapMultiaddrsCached({
    cache: createAlephRelayCache({ storage: memoryRelayCacheStorage(), key: "k" }),
    fetch: registry.fetch,
    refresh: "never",
  });
  assert.deepEqual(result.addrs, []);
  assert.equal(result.refreshed, null);
  assert.equal(registry.calls.count, 0);
});

test("a failing refresh rejects and leaves the cache as it was", async () => {
  const cache = createAlephRelayCache({ storage: memoryRelayCacheStorage(), key: "k" });
  await cache.save(await recordsFor([await registration({ peerId: PEER_A, addr: addrOf(PEER_A) })]));

  const result = await discoverAlephBootstrapMultiaddrsCached({ cache, fetch: failingFetch, refresh: "always" });
  await assert.rejects(result.refreshed, /Aleph unreachable/);
  assert.deepEqual((await cache.load()).map((record) => record.content.peerId), [PEER_A]);
});

test("an empty answer from Aleph keeps the cache", async () => {
  const cache = createAlephRelayCache({ storage: memoryRelayCacheStorage(), key: "k" });
  await cache.save(await recordsFor([await registration({ peerId: PEER_A, addr: addrOf(PEER_A) })]));

  const refreshed = await refreshAlephRelayCache({ cache, fetch: registryFetch([]).fetch }, [addrOf(PEER_A)]);
  assert.deepEqual(refreshed, { addrs: [addrOf(PEER_A)], added: [], removed: [] });
  assert.equal((await cache.load()).length, 1);
});

// --- the libp2p discovery service --------------------------------------------

function fakeComponents({ connectedTo = [], dialFails = [] } = {}) {
  const merged = [];
  const dialled = [];
  return {
    merged,
    dialled,
    components: {
      peerStore: {
        merge: async (peerId, data) => {
          merged.push({ peerId: peerId.toString(), data });
        },
      },
      connectionManager: {
        openConnection: async (peerId) => {
          dialled.push(peerId.toString());
          if (dialFails.includes(peerId.toString())) throw new Error("dial failed");
          return {};
        },
        getConnections: () => connectedTo.map((peerId) => ({ remotePeer: peerId })),
      },
    },
  };
}

function collectPeers(service) {
  const peers = [];
  service.addEventListener("peer", (event) => {
    peers.push({ id: event.detail.id.toString(), multiaddrs: event.detail.multiaddrs.map(String) });
  });
  return peers;
}

const settle = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

test("the discovery service announces and dials remembered relays without asking Aleph", async () => {
  const cache = createAlephRelayCache({ storage: memoryRelayCacheStorage(), key: "k" });
  await cache.save(await recordsFor([await registration({ peerId: PEER_A, addr: addrOf(PEER_A) })]));
  const registry = registryFetch([]);
  const { components, merged, dialled } = fakeComponents({ connectedTo: [PEER_A] });

  const service = alephBootstrapDiscovery({ cache, fetch: registry.fetch, refreshIfSilentMs: 0 })(components);
  const peers = collectPeers(service);
  service.start();
  service.afterStart();
  await settle();

  assert.deepEqual(peers, [{ id: PEER_A, multiaddrs: [addrOf(PEER_A)] }]);
  assert.deepEqual(merged.map((entry) => entry.peerId), [PEER_A]);
  assert.ok(merged[0].data.tags["aleph-bootstrap"]);
  assert.deepEqual(dialled, [PEER_A]);
  assert.equal(registry.calls.count, 0);
  service.stop();
});

test("the discovery service announces what a refresh finds after the remembered relays", async () => {
  const cache = createAlephRelayCache({ storage: memoryRelayCacheStorage(), key: "k" });
  await cache.save(await recordsFor([await registration({ peerId: PEER_A, addr: addrOf(PEER_A) })]));
  let answer;
  const answered = new Promise((resolve) => {
    answer = resolve;
  });
  const registry = registryFetch(async () => {
    await answered;
    return [await registration({ peerId: PEER_B, addr: addrOf(PEER_B, "relay-b.example.com") })];
  });
  const { components } = fakeComponents();

  const service = alephBootstrapDiscovery({ cache, fetch: registry.fetch, refresh: "always" })(components);
  const peers = collectPeers(service);
  service.start();
  service.afterStart();
  await settle();
  assert.deepEqual(peers.map((peer) => peer.id), [PEER_A], "the remembered relay comes first, before Aleph answers");

  answer();
  await settle(100);
  assert.deepEqual(peers.map((peer) => peer.id), [PEER_A, PEER_B]);
  service.stop();
});

test("the discovery service asks Aleph when no remembered relay answers", async () => {
  const cache = createAlephRelayCache({ storage: memoryRelayCacheStorage(), key: "k" });
  await cache.save(await recordsFor([await registration({ peerId: PEER_A, addr: addrOf(PEER_A) })]));
  const registry = registryFetch([await registration({ peerId: PEER_C, addr: addrOf(PEER_C, "relay-c.example.com") })]);
  const { components } = fakeComponents({ dialFails: [PEER_A] });

  const service = alephBootstrapDiscovery({ cache, fetch: registry.fetch, refreshIfSilentMs: 30 })(components);
  const peers = collectPeers(service);
  service.start();
  service.afterStart();
  await settle(150);

  assert.equal(registry.calls.count, 1);
  assert.deepEqual(peers.map((peer) => peer.id), [PEER_A, PEER_C]);
  service.stop();
});

test("a stopped discovery service announces nothing", async () => {
  const cache = createAlephRelayCache({ storage: memoryRelayCacheStorage(), key: "k" });
  await cache.save(await recordsFor([await registration({ peerId: PEER_A, addr: addrOf(PEER_A) })]));
  const { components } = fakeComponents();

  const service = alephBootstrapDiscovery({ cache, fetch: registryFetch([]).fetch, refreshIfSilentMs: 0 })(components);
  const peers = collectPeers(service);
  service.start();
  service.stop();
  service.afterStart();
  await settle();
  assert.deepEqual(peers, []);
});
