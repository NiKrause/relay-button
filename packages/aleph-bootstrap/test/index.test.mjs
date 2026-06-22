import test from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";

import {
  DEFAULT_ALEPH_BOOTSTRAP_COMPACT_POST_TYPE,
  buildRelayBootstrapPostContent,
  createRelayBootstrapPost,
  dedupeMultiaddrs,
  discoverAlephBootstrapMultiaddrs,
  filterPublicMultiaddrs,
  relayBootstrapMultiaddrsHash,
  relayBootstrapTrustMode,
  selectCompactRelayBootstrapMultiaddrs,
  signRelayBootstrapAuthorization,
  signRelayBootstrapProof,
  selectCurrentRelayBootstrapPosts,
  verifyRelayBootstrapAuthorization,
  verifyRelayBootstrapDualKeyContent,
  verifyRelayBootstrapProof,
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

test("buildRelayBootstrapPostContent can emit compact v2 browser records", () => {
  const browserAddrs = [
    "/ip4/203.0.113.10/udp/9095/quic-v1/webtransport/p2p/12D3KooWPublic",
    "/dns4/relay.example.com/tcp/443/tls/ws/p2p/12D3KooWPublic",
    "/dns6/relay.example.com/tcp/443/tls/ws/p2p/12D3KooWPublic",
    "/dns4/relay.example.com/tcp/9095/tls/ws/p2p/12D3KooWPublic",
    "/dns6/relay.example.com/tcp/9095/tls/ws/p2p/12D3KooWPublic",
    "/ip4/203.0.113.10/udp/9096/webrtc-direct/p2p/12D3KooWPublic",
    "/ip6/2001:db8::10/udp/9096/webrtc-direct/p2p/12D3KooWPublic",
  ];
  const content = buildRelayBootstrapPostContent({
    sender: "0xabc",
    peerId: "12D3KooWPublic",
    postType: DEFAULT_ALEPH_BOOTSTRAP_COMPACT_POST_TYPE,
    multiaddrs: ["/ip4/203.0.113.10/tcp/9095/p2p/12D3KooWPublic"],
    browserMultiaddrs: browserAddrs,
    now: 1234,
  });

  assert.equal(content.type, DEFAULT_ALEPH_BOOTSTRAP_COMPACT_POST_TYPE);
  assert.deepEqual(content.content.multiaddrs, [
    "/dns4/relay.example.com/tcp/443/tls/ws/p2p/12D3KooWPublic",
    "/dns6/relay.example.com/tcp/443/tls/ws/p2p/12D3KooWPublic",
    "/dns4/relay.example.com/tcp/9095/tls/ws/p2p/12D3KooWPublic",
    "/ip4/203.0.113.10/udp/9095/quic-v1/webtransport/p2p/12D3KooWPublic",
    "/ip4/203.0.113.10/udp/9096/webrtc-direct/p2p/12D3KooWPublic",
    "/ip6/2001:db8::10/udp/9096/webrtc-direct/p2p/12D3KooWPublic",
  ]);
  assert.equal(content.content.browserMultiaddrs, undefined);
  assert.deepEqual(selectCompactRelayBootstrapMultiaddrs(browserAddrs, 2), [
    "/dns4/relay.example.com/tcp/443/tls/ws/p2p/12D3KooWPublic",
    "/dns6/relay.example.com/tcp/443/tls/ws/p2p/12D3KooWPublic",
    "/ip4/203.0.113.10/udp/9095/quic-v1/webtransport/p2p/12D3KooWPublic",
    "/ip4/203.0.113.10/udp/9096/webrtc-direct/p2p/12D3KooWPublic",
    "/ip6/2001:db8::10/udp/9096/webrtc-direct/p2p/12D3KooWPublic",
  ]);
});

test("buildRelayBootstrapPostContent can carry dual-key authorization metadata", () => {
  const content = buildRelayBootstrapPostContent({
    sender: "0xpublisher",
    ownerAddress: "0xowner",
    publisherAddress: "0xpublisher",
    peerId: "12D3KooWPublic",
    multiaddrs: ["/dns4/relay.example.com/tcp/443/tls/ws/p2p/12D3KooWPublic"],
    registrationId: "relay:demo",
    profile: "orbitdb-relay",
    version: "0.4.0",
    authorization: {
      scheme: "personal_sign",
      signature: "0xauth",
      payload: {
        ownerAddress: "0xowner",
        publisherAddress: "0xpublisher",
        peerId: "12D3KooWPublic",
        registrationId: "relay:demo",
        profile: "orbitdb-relay",
        version: "0.4.0",
        issuedAt: 111,
      },
    },
    relayProof: {
      scheme: "personal_sign",
      signature: "0xrelay",
      payload: {
        peerId: "12D3KooWPublic",
        multiaddrs: ["/dns4/relay.example.com/tcp/443/tls/ws/p2p/12D3KooWPublic"],
        registrationId: "relay:demo",
        profile: "orbitdb-relay",
        version: "0.4.0",
        updatedAt: 1234,
      },
    },
    now: 1234,
  });

  assert.equal(content.content.ownerAddress, "0xowner");
  assert.equal(content.content.publisherAddress, "0xpublisher");
  assert.equal(content.content.authorization?.signature, "0xauth");
  assert.equal(content.content.relayProof?.signature, "0xrelay");
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

test("discoverAlephBootstrapMultiaddrs accepts posts carrying dual-key proof metadata", async () => {
  const owner = privateKeyToAccount(
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
  const publisher = privateKeyToAccount(
    "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  );
  const signer = async (address, payload) => {
    const account =
      address.toLowerCase() === owner.address.toLowerCase() ? owner : publisher;
    return account.signMessage({ message: payload });
  };
  const now = Date.now();
  const authorization = await signRelayBootstrapAuthorization({
    ownerAddress: owner.address,
    publisherAddress: publisher.address,
    peerId: "12D3KooWProof",
    issuedAt: now - 1_000,
    signer,
  });
  const relayProof = await signRelayBootstrapProof({
    publisherAddress: publisher.address,
    peerId: "12D3KooWProof",
    multiaddrs: ["/dns4/relay-proof.example.com/tcp/443/tls/ws/p2p/12D3KooWProof"],
    browserMultiaddrs: ["/dns4/relay-proof.example.com/tcp/443/tls/ws/p2p/12D3KooWProof"],
    updatedAt: now,
    signer,
  });
  const fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        posts: [
          {
            hash: "hash-proof",
            item_hash: "item-proof",
            address: publisher.address,
            type: "relay-bootstrap",
            ref: "simple-todo-bootstrap",
            content: {
              peerId: "12D3KooWProof",
              ownerAddress: owner.address,
              publisherAddress: publisher.address,
              updatedAt: now,
              multiaddrs: ["/dns4/relay-proof.example.com/tcp/443/tls/ws/p2p/12D3KooWProof"],
              browserMultiaddrs: ["/dns4/relay-proof.example.com/tcp/443/tls/ws/p2p/12D3KooWProof"],
              authorization,
              relayProof,
            },
          },
        ],
      };
    },
  });

  const addrs = await discoverAlephBootstrapMultiaddrs({ fetch });
  assert.deepEqual(addrs, [
    "/dns4/relay-proof.example.com/tcp/443/tls/ws/p2p/12D3KooWProof",
  ]);
});

test("discoverAlephBootstrapMultiaddrs ignores invalid dual-key proof records", async () => {
  const now = Date.now();
  const fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        posts: [
          {
            hash: "hash-invalid-proof",
            item_hash: "item-invalid-proof",
            address: "0xpublisher",
            type: "relay-bootstrap",
            ref: "simple-todo-bootstrap",
            content: {
              peerId: "12D3KooWProof",
              ownerAddress: "0xowner",
              publisherAddress: "0xpublisher",
              updatedAt: now,
              multiaddrs: ["/dns4/relay-proof.example.com/tcp/443/tls/ws/p2p/12D3KooWProof"],
              browserMultiaddrs: ["/dns4/relay-proof.example.com/tcp/443/tls/ws/p2p/12D3KooWProof"],
              authorization: {
                scheme: "personal_sign",
                signature: "0xdeadbeef",
                payload: {
                  ownerAddress: "0xowner",
                  publisherAddress: "0xpublisher",
                  peerId: "12D3KooWProof",
                  issuedAt: now - 1_000,
                },
              },
              relayProof: {
                scheme: "personal_sign",
                signature: "0xbeefdead",
                payload: {
                  peerId: "12D3KooWProof",
                  multiaddrs: ["/dns4/relay-proof.example.com/tcp/443/tls/ws/p2p/12D3KooWProof"],
                  browserMultiaddrs: ["/dns4/relay-proof.example.com/tcp/443/tls/ws/p2p/12D3KooWProof"],
                  updatedAt: now,
                },
              },
            },
          },
        ],
      };
    },
  });

  const addrs = await discoverAlephBootstrapMultiaddrs({ fetch });
  assert.deepEqual(addrs, []);
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

test("discoverAlephBootstrapMultiaddrs scans later pages when page 1 has no usable addrs", async () => {
  const now = Date.now();
  const requestedPages = [];
  const fetch = async (url) => {
    const parsed = new URL(url);
    requestedPages.push(parsed.searchParams.get("page"));

    const page = Number(parsed.searchParams.get("page"));
    return {
      ok: true,
      status: 200,
      async json() {
        if (page === 1) {
          return {
            posts: [
              {
                hash: "hash-local-only",
                type: "relay-bootstrap",
                ref: "simple-todo-bootstrap",
                content: {
                  peerId: "12D3KooWLocalOnly",
                  updatedAt: now,
                  multiaddrs: ["/ip4/127.0.0.1/tcp/4001/p2p/12D3KooWLocalOnly"],
                  browserMultiaddrs: ["/dns4/localhost/tcp/443/tls/ws/p2p/12D3KooWLocalOnly"],
                },
              },
            ],
          };
        }

        return {
          posts: [
            {
              hash: "hash-page-2",
              type: "relay-bootstrap",
              ref: "simple-todo-bootstrap",
              content: {
                peerId: "12D3KooWPage2",
                updatedAt: now,
                multiaddrs: ["/dns4/relay-page-2.example.com/tcp/443/tls/ws/p2p/12D3KooWPage2"],
                browserMultiaddrs: ["/dns4/relay-page-2.example.com/tcp/443/tls/ws/p2p/12D3KooWPage2"],
              },
            },
          ],
        };
      },
    };
  };

  const addrs = await discoverAlephBootstrapMultiaddrs({
    fetch,
    pagination: 1,
    maxPages: 3,
  });

  assert.deepEqual(requestedPages, ["1", "2"]);
  assert.deepEqual(addrs, [
    "/dns4/relay-page-2.example.com/tcp/443/tls/ws/p2p/12D3KooWPage2",
  ]);
});

test("discoverAlephBootstrapMultiaddrs falls back from compact v2 to legacy posts", async () => {
  const now = Date.now();
  const requestedTypes = [];
  const fetch = async (url) => {
    const parsed = new URL(url);
    const postType = parsed.searchParams.get("types");
    requestedTypes.push(postType);

    return {
      ok: true,
      status: 200,
      async json() {
        if (postType === DEFAULT_ALEPH_BOOTSTRAP_COMPACT_POST_TYPE) {
          return { posts: [] };
        }
        return {
          posts: [
            {
              hash: "hash-legacy",
              type: "relay-bootstrap",
              ref: "simple-todo-bootstrap",
              content: {
                peerId: "12D3KooWLegacy",
                updatedAt: now,
                multiaddrs: ["/dns4/relay-legacy.example.com/tcp/443/tls/ws/p2p/12D3KooWLegacy"],
              },
            },
          ],
        };
      },
    };
  };

  const addrs = await discoverAlephBootstrapMultiaddrs({ fetch });
  assert.deepEqual(requestedTypes, [
    DEFAULT_ALEPH_BOOTSTRAP_COMPACT_POST_TYPE,
    "relay-bootstrap",
  ]);
  assert.deepEqual(addrs, [
    "/dns4/relay-legacy.example.com/tcp/443/tls/ws/p2p/12D3KooWLegacy",
  ]);
});

test("selectCurrentRelayBootstrapPosts keeps only the newest record per sender identity", () => {
  const now = Date.now();
  const posts = selectCurrentRelayBootstrapPosts([
    {
      hash: "hash-old",
      itemHash: "item-old",
      address: "0xabc",
      ref: "simple-todo-bootstrap",
      type: "relay-bootstrap",
      time: now / 1000,
      content: {
        peerId: "12D3KooWOld",
        updatedAt: now - 1_000,
        multiaddrs: ["/dns4/relay-old.example.com/tcp/443/tls/ws/p2p/12D3KooWOld"],
      },
    },
    {
      hash: "hash-new",
      itemHash: "item-new",
      address: "0xabc",
      ref: "simple-todo-bootstrap",
      type: "relay-bootstrap",
      time: now / 1000,
      content: {
        peerId: "12D3KooWNew",
        updatedAt: now,
        multiaddrs: ["/dns4/relay-new.example.com/tcp/443/tls/ws/p2p/12D3KooWNew"],
      },
    },
    {
      hash: "hash-other",
      itemHash: "item-other",
      address: "0xdef",
      ref: "simple-todo-bootstrap",
      type: "relay-bootstrap",
      time: now / 1000,
      content: {
        peerId: "12D3KooWOther",
        updatedAt: now,
        multiaddrs: ["/dns4/relay-other.example.com/tcp/443/tls/ws/p2p/12D3KooWOther"],
      },
    },
  ]);

  assert.deepEqual(
    posts.map((post) => post.itemHash),
    ["item-new", "item-other"],
  );
});

test("relayBootstrapTrustMode distinguishes legacy and dual-key records", () => {
  assert.equal(
    relayBootstrapTrustMode({
      peerId: "12D3KooWLegacy",
      multiaddrs: ["/dns4/relay-legacy.example.com/tcp/443/tls/ws/p2p/12D3KooWLegacy"],
      updatedAt: 1,
    }),
    "legacy-wallet-signed",
  );

  assert.equal(
    relayBootstrapTrustMode({
      peerId: "12D3KooWProof",
      multiaddrs: ["/dns4/relay-proof.example.com/tcp/443/tls/ws/p2p/12D3KooWProof"],
      ownerAddress: "0xowner",
      publisherAddress: "0xpublisher",
      authorization: {
        scheme: "personal_sign",
        signature: "0xauth",
        payload: {
          ownerAddress: "0xowner",
          publisherAddress: "0xpublisher",
          peerId: "12D3KooWProof",
          issuedAt: 1,
        },
      },
      relayProof: {
        scheme: "personal_sign",
        signature: "0xrelay",
        payload: {
          peerId: "12D3KooWProof",
          multiaddrs: ["/dns4/relay-proof.example.com/tcp/443/tls/ws/p2p/12D3KooWProof"],
          updatedAt: 2,
        },
      },
      updatedAt: 2,
    }),
    "dual-key-attested",
  );
});

test("discoverAlephBootstrapMultiaddrs can require dual-key attestation", async () => {
  const now = Date.now();
  const fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        posts: [
          {
            hash: "hash-legacy",
            item_hash: "item-legacy",
            address: "0xlegacy",
            type: "relay-bootstrap",
            ref: "simple-todo-bootstrap",
            content: {
              peerId: "12D3KooWLegacy",
              updatedAt: now,
              multiaddrs: ["/dns4/relay-legacy.example.com/tcp/443/tls/ws/p2p/12D3KooWLegacy"],
              browserMultiaddrs: ["/dns4/relay-legacy.example.com/tcp/443/tls/ws/p2p/12D3KooWLegacy"],
            },
          },
        ],
      };
    },
  });

  assert.deepEqual(
    await discoverAlephBootstrapMultiaddrs({ fetch, requireDualKeyAttestation: true }),
    [],
  );
});

test("dual-key authorization and relay proof can be signed and verified", async () => {
  const owner = privateKeyToAccount(
    "0x1111111111111111111111111111111111111111111111111111111111111111",
  );
  const publisher = privateKeyToAccount(
    "0x2222222222222222222222222222222222222222222222222222222222222222",
  );
  const signer = async (address, payload) => {
    const account =
      address.toLowerCase() === owner.address.toLowerCase() ? owner : publisher;
    return account.signMessage({ message: payload });
  };

  const authorization = await signRelayBootstrapAuthorization({
    ownerAddress: owner.address,
    publisherAddress: publisher.address,
    peerId: "12D3KooWProof",
    registrationId: "relay:proof",
    profile: "orbitdb-relay",
    version: "0.4.0",
    issuedAt: 100,
    signer,
  });

  const proof = await signRelayBootstrapProof({
    publisherAddress: publisher.address,
    peerId: "12D3KooWProof",
    multiaddrs: ["/dns4/relay-proof.example.com/tcp/443/tls/ws/p2p/12D3KooWProof"],
    browserMultiaddrs: ["/dns4/relay-proof.example.com/tcp/443/tls/ws/p2p/12D3KooWProof"],
    registrationId: "relay:proof",
    profile: "orbitdb-relay",
    version: "0.4.0",
    updatedAt: 200,
    signer,
  });

  assert.equal((await verifyRelayBootstrapAuthorization(authorization)).ok, true);
  assert.equal(
    (
      await verifyRelayBootstrapProof(proof, {
        expectedPublisherAddress: publisher.address,
        expectedPeerId: "12D3KooWProof",
      })
    ).ok,
    true,
  );

  const verified = await verifyRelayBootstrapDualKeyContent({
    peerId: "12D3KooWProof",
    multiaddrs: ["/dns4/relay-proof.example.com/tcp/443/tls/ws/p2p/12D3KooWProof"],
    browserMultiaddrs: ["/dns4/relay-proof.example.com/tcp/443/tls/ws/p2p/12D3KooWProof"],
    registrationId: "relay:proof",
    profile: "orbitdb-relay",
    version: "0.4.0",
    ownerAddress: owner.address,
    publisherAddress: publisher.address,
    authorization,
    relayProof: proof,
    updatedAt: 200,
  });

  assert.equal(verified.ok, true);
  assert.deepEqual(verified.errors, []);
});

test("compact relay proofs verify against signed multiaddr hashes", async () => {
  const owner = privateKeyToAccount(
    "0x7777777777777777777777777777777777777777777777777777777777777777",
  );
  const publisher = privateKeyToAccount(
    "0x6666666666666666666666666666666666666666666666666666666666666666",
  );
  const signer = async (address, payload) => {
    const account =
      address.toLowerCase() === owner.address.toLowerCase() ? owner : publisher;
    return account.signMessage({ message: payload });
  };
  const addrs = [
    "/dns4/relay-proof.example.com/tcp/443/tls/ws/p2p/12D3KooWProof",
    "/dns6/relay-proof.example.com/tcp/443/tls/ws/p2p/12D3KooWProof",
  ];
  const authorization = await signRelayBootstrapAuthorization({
    ownerAddress: owner.address,
    publisherAddress: publisher.address,
    peerId: "12D3KooWProof",
    registrationId: "relay:proof",
    profile: "orbitdb-relay",
    version: "0.4.0",
    issuedAt: 100,
    signer,
  });
  const proof = await signRelayBootstrapProof({
    publisherAddress: publisher.address,
    peerId: "12D3KooWProof",
    multiaddrs: ["/ip4/203.0.113.10/tcp/9095/p2p/12D3KooWProof"],
    browserMultiaddrs: addrs,
    registrationId: "relay:proof",
    profile: "orbitdb-relay",
    version: "0.4.0",
    updatedAt: 200,
    compact: true,
    signer,
  });

  assert.equal(proof.payload.multiaddrs, undefined);
  assert.equal(proof.payload.browserMultiaddrs, undefined);
  assert.equal(proof.payload.multiaddrsHash, relayBootstrapMultiaddrsHash(addrs));

  const verified = await verifyRelayBootstrapProof(proof, {
    expectedPublisherAddress: publisher.address,
    expectedPeerId: "12D3KooWProof",
  });
  assert.equal(verified.ok, true);

  const contentVerified = await verifyRelayBootstrapDualKeyContent({
    peerId: "12D3KooWProof",
    multiaddrs: addrs,
    registrationId: "relay:proof",
    profile: "orbitdb-relay",
    version: "0.4.0",
    ownerAddress: owner.address,
    publisherAddress: publisher.address,
    authorization,
    relayProof: proof,
    updatedAt: 200,
  });
  assert.equal(contentVerified.ok, true);
  assert.deepEqual(contentVerified.errors, []);
});

test("dual-key verification fails when relay proof publisher does not match", async () => {
  const owner = privateKeyToAccount(
    "0x3333333333333333333333333333333333333333333333333333333333333333",
  );
  const publisher = privateKeyToAccount(
    "0x4444444444444444444444444444444444444444444444444444444444444444",
  );
  const wrongPublisher = privateKeyToAccount(
    "0x5555555555555555555555555555555555555555555555555555555555555555",
  );
  const signer = async (address, payload) => {
    const account =
      address.toLowerCase() === owner.address.toLowerCase()
        ? owner
        : address.toLowerCase() === publisher.address.toLowerCase()
          ? publisher
          : wrongPublisher;
    return account.signMessage({ message: payload });
  };

  const authorization = await signRelayBootstrapAuthorization({
    ownerAddress: owner.address,
    publisherAddress: publisher.address,
    peerId: "12D3KooWProof",
    issuedAt: 100,
    signer,
  });

  const wrongProof = await signRelayBootstrapProof({
    publisherAddress: wrongPublisher.address,
    peerId: "12D3KooWProof",
    multiaddrs: ["/dns4/relay-proof.example.com/tcp/443/tls/ws/p2p/12D3KooWProof"],
    updatedAt: 200,
    signer,
  });

  const verified = await verifyRelayBootstrapDualKeyContent({
    peerId: "12D3KooWProof",
    multiaddrs: ["/dns4/relay-proof.example.com/tcp/443/tls/ws/p2p/12D3KooWProof"],
    ownerAddress: owner.address,
    publisherAddress: publisher.address,
    authorization,
    relayProof: wrongProof,
    updatedAt: 200,
  });

  assert.equal(verified.ok, false);
  assert.match(
    verified.errors.join("\n"),
    /expected publisher address|publisherAddress does not match/i,
  );
});
