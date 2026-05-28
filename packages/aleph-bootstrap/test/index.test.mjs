import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRelayBootstrapPostContent,
  createRelayBootstrapPost,
  dedupeMultiaddrs,
  discoverAlephBootstrapMultiaddrs,
  filterPublicMultiaddrs,
} from "../dist/index.js";

test("filterPublicMultiaddrs drops local and private addresses", () => {
  const addrs = filterPublicMultiaddrs([
    "/ip4/127.0.0.1/tcp/4001/ws/p2p/12D3KooWLocal",
    "/ip4/192.168.1.15/tcp/4001/ws/p2p/12D3KooWPrivate",
    "/dns4/localhost/tcp/443/tls/ws/p2p/12D3KooWLocalhost",
    "/dns4/relay.example.com/tcp/443/tls/ws/p2p/12D3KooWPublic",
  ]);

  assert.deepEqual(addrs, [
    "/dns4/relay.example.com/tcp/443/tls/ws/p2p/12D3KooWPublic",
  ]);
});

test("filterPublicMultiaddrs can keep only browser dialable addresses", () => {
  const addrs = filterPublicMultiaddrs(
    [
      "/ip4/203.0.113.10/tcp/9095/p2p/12D3KooWTcp",
      "/dns4/relay.example.com/tcp/443/tls/ws/p2p/12D3KooWWs",
      "/ip4/203.0.113.10/udp/9095/quic-v1/webtransport/p2p/12D3KooWWt",
    ],
    { browserDialableOnly: true },
  );

  assert.deepEqual(addrs, [
    "/dns4/relay.example.com/tcp/443/tls/ws/p2p/12D3KooWWs",
    "/ip4/203.0.113.10/udp/9095/quic-v1/webtransport/p2p/12D3KooWWt",
  ]);
});

test("buildRelayBootstrapPostContent keeps public addrs and browser subset", () => {
  const content = buildRelayBootstrapPostContent({
    sender: "0xabc",
    peerId: "12D3KooWPublic",
    multiaddrs: [
      "/ip4/203.0.113.10/tcp/9095/p2p/12D3KooWPublic",
      "/ip4/127.0.0.1/tcp/9095/p2p/12D3KooWLocal",
    ],
    browserMultiaddrs: [
      "/dns4/relay.example.com/tcp/443/tls/ws/p2p/12D3KooWPublic",
      "/ip4/10.0.0.2/tcp/9097/ws/p2p/12D3KooWPrivate",
    ],
    now: 1234,
  });

  assert.deepEqual(content.content.multiaddrs, [
    "/ip4/203.0.113.10/tcp/9095/p2p/12D3KooWPublic",
  ]);
  assert.deepEqual(content.content.browserMultiaddrs, [
    "/dns4/relay.example.com/tcp/443/tls/ws/p2p/12D3KooWPublic",
  ]);
  assert.equal(content.content.updatedAt, 1234);
});

test("createRelayBootstrapPost builds an Aleph POST envelope", async () => {
  const post = await createRelayBootstrapPost({
    sender: "0xabc",
    peerId: "12D3KooWPublic",
    multiaddrs: ["/dns4/relay.example.com/tcp/443/tls/ws/p2p/12D3KooWPublic"],
    hasher: async () => "deadbeef",
    now: 10_000,
  });

  assert.equal(post.type, "POST");
  assert.equal(post.item_hash, "deadbeef");
  assert.match(post.item_content, /"type":"relay-bootstrap"/);
  assert.match(post.item_content, /"ref":"simple-todo-bootstrap"/);
});

test("discoverAlephBootstrapMultiaddrs dedupes and skips stale entries", async () => {
  const now = Date.now();
  const fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        posts: [
          {
            hash: "hash-1",
            type: "relay-bootstrap",
            ref: "simple-todo-bootstrap",
            content: {
              peerId: "12D3KooWFresh",
              updatedAt: now,
              multiaddrs: ["/dns4/relay-a.example.com/tcp/443/tls/ws/p2p/12D3KooWFresh"],
              browserMultiaddrs: ["/dns4/relay-a.example.com/tcp/443/tls/ws/p2p/12D3KooWFresh"],
            },
          },
          {
            hash: "hash-2",
            type: "relay-bootstrap",
            ref: "simple-todo-bootstrap",
            content: {
              peerId: "12D3KooWStale",
              updatedAt: now - 9 * 24 * 60 * 60 * 1000,
              multiaddrs: ["/dns4/relay-b.example.com/tcp/443/tls/ws/p2p/12D3KooWStale"],
            },
          },
          {
            hash: "hash-3",
            type: "relay-bootstrap",
            ref: "simple-todo-bootstrap",
            content: {
              peerId: "12D3KooWFresh2",
              updatedAt: now,
              multiaddrs: ["/dns4/relay-a.example.com/tcp/443/tls/ws/p2p/12D3KooWFresh"],
            },
          },
        ],
      };
    },
  });

  const addrs = await discoverAlephBootstrapMultiaddrs({ fetch });
  assert.deepEqual(addrs, [
    "/dns4/relay-a.example.com/tcp/443/tls/ws/p2p/12D3KooWFresh",
  ]);
  assert.deepEqual(
    dedupeMultiaddrs([
      "/dns4/relay-a.example.com/tcp/443/tls/ws/p2p/12D3KooWFresh",
      "/dns4/relay-a.example.com/tcp/443/tls/ws/p2p/12D3KooWFresh",
    ]),
    ["/dns4/relay-a.example.com/tcp/443/tls/ws/p2p/12D3KooWFresh"],
  );
});
