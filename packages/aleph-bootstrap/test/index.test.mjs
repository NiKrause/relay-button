import test from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";

import {
  DEFAULT_ALEPH_BOOTSTRAP_POST_TYPE,
  buildRelayBootstrapPostContent,
  createRelayBootstrapPost,
  dedupeMultiaddrs,
  discoverAlephBootstrapMultiaddrs,
  filterRelayBootstrapPostsByRegistration,
  filterPublicMultiaddrs,
  isBrowserDialableMultiaddr,
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
      "/ip4/203.0.113.10/udp/9095/quic-v1/webtransport/certhash/uEiWebTransport/p2p/12D3KooWWt",
      "/ip4/203.0.113.10/udp/9096/webrtc-direct/p2p/12D3KooWInvalid",
    ],
    { browserDialableOnly: true },
  );

  assert.deepEqual(addrs, [
    "/dns4/relay.example.com/tcp/443/tls/ws/p2p/12D3KooWWs",
    "/ip4/203.0.113.10/udp/9095/quic-v1/webtransport/certhash/uEiWebTransport/p2p/12D3KooWWt",
  ]);
});

test("filterPublicMultiaddrs drops plaintext ws from the browser dialable set", () => {
  const candidates = [
    "/ip4/93.186.192.85/tcp/24057/ws/p2p/12D3KooWPlain",
    "/ip6/2001:db8::10/tcp/9092/ws/p2p/12D3KooWPlainV6",
    "/dns4/relay.example.com/tcp/443/tls/ws/p2p/12D3KooWTls",
    "/dns4/relay.example.com/tcp/443/wss/p2p/12D3KooWWss",
    "/ip4/93.186.192.85/tcp/443/tls/sni/relay.example.com/ws/p2p/12D3KooWSni",
  ];

  assert.deepEqual(
    filterPublicMultiaddrs(candidates, { browserDialableOnly: true }),
    [
      "/dns4/relay.example.com/tcp/443/tls/ws/p2p/12D3KooWTls",
      "/dns4/relay.example.com/tcp/443/wss/p2p/12D3KooWWss",
      "/ip4/93.186.192.85/tcp/443/tls/sni/relay.example.com/ws/p2p/12D3KooWSni",
    ],
  );

  assert.deepEqual(
    filterPublicMultiaddrs(candidates, {
      browserDialableOnly: true,
      allowInsecureWebSockets: true,
    }),
    candidates,
  );
});

test("isBrowserDialableMultiaddr separates ws from wss", () => {
  assert.equal(
    isBrowserDialableMultiaddr("/ip4/93.186.192.85/tcp/24057/ws/p2p/12D3KooW"),
    false,
  );
  assert.equal(
    isBrowserDialableMultiaddr("/ip4/93.186.192.85/tcp/24057/ws/p2p/12D3KooW", {
      allowInsecureWebSockets: true,
    }),
    true,
  );
  assert.equal(
    isBrowserDialableMultiaddr(
      "/dns4/relay.example.com/tcp/443/tls/ws/p2p/12D3KooW",
    ),
    true,
  );
  assert.equal(
    isBrowserDialableMultiaddr("/ip4/203.0.113.10/tcp/9095/p2p/12D3KooW"),
    false,
  );
});

test("a relay still announces the plaintext port it really serves", () => {
  const content = buildRelayBootstrapPostContent({
    sender: "0xabc",
    peerId: "12D3KooWPlain",
    multiaddrs: ["/ip4/93.186.192.85/tcp/24057/ws/p2p/12D3KooWPlain"],
    now: 1234,
  });

  assert.deepEqual(content.content.multiaddrs, [
    "/ip4/93.186.192.85/tcp/24057/ws/p2p/12D3KooWPlain",
  ]);
});

test("buildRelayBootstrapPostContent emits only compact v2 browser addresses", () => {
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
    "/dns4/relay.example.com/tcp/443/tls/ws/p2p/12D3KooWPublic",
  ]);
  assert.equal(content.content.browserMultiaddrs, undefined);
  assert.equal(content.type, DEFAULT_ALEPH_BOOTSTRAP_POST_TYPE);
  assert.equal(content.content.updatedAt, 1234);
});

test("buildRelayBootstrapPostContent limits compact v2 addresses per transport", () => {
  const browserAddrs = [
    "/ip4/203.0.113.10/udp/9095/quic-v1/webtransport/certhash/uEiWebTransport/p2p/12D3KooWPublic",
    "/dns4/relay.example.com/tcp/443/tls/ws/p2p/12D3KooWPublic",
    "/dns6/relay.example.com/tcp/443/tls/ws/p2p/12D3KooWPublic",
    "/dns4/relay.example.com/tcp/9095/tls/ws/p2p/12D3KooWPublic",
    "/dns6/relay.example.com/tcp/9095/tls/ws/p2p/12D3KooWPublic",
    "/ip4/203.0.113.10/udp/9096/webrtc-direct/certhash/uEiWebRtc/p2p/12D3KooWPublic",
    "/ip6/2001:db8::10/udp/9096/webrtc-direct/certhash/uEiWebRtc/p2p/12D3KooWPublic",
  ];
  const content = buildRelayBootstrapPostContent({
    sender: "0xabc",
    peerId: "12D3KooWPublic",
    multiaddrs: ["/ip4/203.0.113.10/tcp/9095/p2p/12D3KooWPublic"],
    browserMultiaddrs: browserAddrs,
    now: 1234,
  });

  assert.equal(content.type, DEFAULT_ALEPH_BOOTSTRAP_POST_TYPE);
  assert.deepEqual(content.content.multiaddrs, [
    "/dns4/relay.example.com/tcp/443/tls/ws/p2p/12D3KooWPublic",
    "/dns6/relay.example.com/tcp/443/tls/ws/p2p/12D3KooWPublic",
    "/dns4/relay.example.com/tcp/9095/tls/ws/p2p/12D3KooWPublic",
    "/ip4/203.0.113.10/udp/9095/quic-v1/webtransport/certhash/uEiWebTransport/p2p/12D3KooWPublic",
    "/ip4/203.0.113.10/udp/9096/webrtc-direct/certhash/uEiWebRtc/p2p/12D3KooWPublic",
    "/ip6/2001:db8::10/udp/9096/webrtc-direct/certhash/uEiWebRtc/p2p/12D3KooWPublic",
  ]);
  assert.equal(content.content.browserMultiaddrs, undefined);
  assert.deepEqual(selectCompactRelayBootstrapMultiaddrs(browserAddrs, 2), [
    "/dns4/relay.example.com/tcp/443/tls/ws/p2p/12D3KooWPublic",
    "/dns6/relay.example.com/tcp/443/tls/ws/p2p/12D3KooWPublic",
    "/ip4/203.0.113.10/udp/9095/quic-v1/webtransport/certhash/uEiWebTransport/p2p/12D3KooWPublic",
    "/ip4/203.0.113.10/udp/9096/webrtc-direct/certhash/uEiWebRtc/p2p/12D3KooWPublic",
    "/ip6/2001:db8::10/udp/9096/webrtc-direct/certhash/uEiWebRtc/p2p/12D3KooWPublic",
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
        multiaddrs: [
          "/dns4/relay.example.com/tcp/443/tls/ws/p2p/12D3KooWPublic",
        ],
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
  assert.match(post.item_content, /"type":"relay-bootstrap-v2"/);
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
    multiaddrs: [
      "/dns4/relay-proof.example.com/tcp/443/tls/ws/p2p/12D3KooWProof",
    ],
    browserMultiaddrs: [
      "/dns4/relay-proof.example.com/tcp/443/tls/ws/p2p/12D3KooWProof",
    ],
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
            type: "relay-bootstrap-v2",
            ref: "simple-todo-bootstrap",
            content: {
              peerId: "12D3KooWProof",
              ownerAddress: owner.address,
              publisherAddress: publisher.address,
              updatedAt: now,
              multiaddrs: [
                "/dns4/relay-proof.example.com/tcp/443/tls/ws/p2p/12D3KooWProof",
              ],
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
            type: "relay-bootstrap-v2",
            ref: "simple-todo-bootstrap",
            content: {
              peerId: "12D3KooWProof",
              ownerAddress: "0xowner",
              publisherAddress: "0xpublisher",
              updatedAt: now,
              multiaddrs: [
                "/dns4/relay-proof.example.com/tcp/443/tls/ws/p2p/12D3KooWProof",
              ],
              browserMultiaddrs: [
                "/dns4/relay-proof.example.com/tcp/443/tls/ws/p2p/12D3KooWProof",
              ],
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
                  multiaddrs: [
                    "/dns4/relay-proof.example.com/tcp/443/tls/ws/p2p/12D3KooWProof",
                  ],
                  browserMultiaddrs: [
                    "/dns4/relay-proof.example.com/tcp/443/tls/ws/p2p/12D3KooWProof",
                  ],
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
            type: "relay-bootstrap-v2",
            ref: "simple-todo-bootstrap",
            content: {
              peerId: "12D3KooWFresh",
              updatedAt: now,
              multiaddrs: [
                "/dns4/relay-a.example.com/tcp/443/tls/ws/p2p/12D3KooWFresh",
              ],
              browserMultiaddrs: [
                "/dns4/relay-a.example.com/tcp/443/tls/ws/p2p/12D3KooWFresh",
              ],
            },
          },
          {
            hash: "hash-2",
            type: "relay-bootstrap-v2",
            ref: "simple-todo-bootstrap",
            content: {
              peerId: "12D3KooWStale",
              updatedAt: now - 9 * 24 * 60 * 60 * 1000,
              multiaddrs: [
                "/dns4/relay-b.example.com/tcp/443/tls/ws/p2p/12D3KooWStale",
              ],
            },
          },
          {
            hash: "hash-3",
            type: "relay-bootstrap-v2",
            ref: "simple-todo-bootstrap",
            content: {
              peerId: "12D3KooWFresh2",
              updatedAt: now,
              multiaddrs: [
                "/dns4/relay-a.example.com/tcp/443/tls/ws/p2p/12D3KooWFresh",
              ],
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

test("discoverAlephBootstrapMultiaddrs scopes discovery to a relay profile", async () => {
  const now = Date.now();
  const fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        posts: [
          {
            hash: "hash-orbitdb",
            type: "relay-bootstrap-v2",
            ref: "simple-todo-bootstrap",
            content: {
              peerId: "12D3KooWOrbit",
              profile: "orbitdb-relay",
              updatedAt: now,
              browserMultiaddrs: [
                "/dns4/orbitdb.example.com/tcp/443/tls/ws/p2p/12D3KooWOrbit",
              ],
            },
          },
          {
            hash: "hash-gopeer",
            type: "relay-bootstrap-v2",
            ref: "simple-todo-bootstrap",
            content: {
              peerId: "12D3KooWGoPeer",
              profile: "uc-go-peer",
              updatedAt: now,
              browserMultiaddrs: [
                "/dns4/gopeer.example.com/tcp/443/tls/ws/p2p/12D3KooWGoPeer",
              ],
            },
          },
        ],
      };
    },
  });

  const scoped = await discoverAlephBootstrapMultiaddrs({
    fetch,
    profile: "orbitdb-relay",
  });
  assert.deepEqual(scoped, [
    "/dns4/orbitdb.example.com/tcp/443/tls/ws/p2p/12D3KooWOrbit",
  ]);

  const unscoped = await discoverAlephBootstrapMultiaddrs({ fetch });
  assert.equal(unscoped.length, 2, "no profile filter returns every relay");
  assert.ok(
    unscoped.includes(
      "/dns4/gopeer.example.com/tcp/443/tls/ws/p2p/12D3KooWGoPeer",
    ),
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
                type: "relay-bootstrap-v2",
                ref: "simple-todo-bootstrap",
                content: {
                  peerId: "12D3KooWLocalOnly",
                  updatedAt: now,
                  multiaddrs: ["/ip4/127.0.0.1/tcp/4001/p2p/12D3KooWLocalOnly"],
                  browserMultiaddrs: [
                    "/dns4/localhost/tcp/443/tls/ws/p2p/12D3KooWLocalOnly",
                  ],
                },
              },
            ],
          };
        }

        return {
          posts: [
            {
              hash: "hash-page-2",
              type: "relay-bootstrap-v2",
              ref: "simple-todo-bootstrap",
              content: {
                peerId: "12D3KooWPage2",
                updatedAt: now,
                multiaddrs: [
                  "/dns4/relay-page-2.example.com/tcp/443/tls/ws/p2p/12D3KooWPage2",
                ],
                browserMultiaddrs: [
                  "/dns4/relay-page-2.example.com/tcp/443/tls/ws/p2p/12D3KooWPage2",
                ],
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

test("discoverAlephBootstrapMultiaddrs rejects legacy v1 records", async () => {
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
        return {
          posts: [
            {
              hash: "hash-legacy",
              type: "relay-bootstrap",
              ref: "simple-todo-bootstrap",
              content: {
                peerId: "12D3KooWLegacy",
                updatedAt: now,
                multiaddrs: [
                  "/dns4/relay-legacy.example.com/tcp/443/tls/ws/p2p/12D3KooWLegacy",
                ],
              },
            },
          ],
        };
      },
    };
  };

  await assert.rejects(
    discoverAlephBootstrapMultiaddrs({ fetch }),
    /Legacy relay-bootstrap record encountered.*relay-bootstrap-v2/,
  );
  assert.deepEqual(requestedTypes, [DEFAULT_ALEPH_BOOTSTRAP_POST_TYPE]);
});

test("selectCurrentRelayBootstrapPosts keeps only the newest record per sender identity", () => {
  const now = Date.now();
  const posts = selectCurrentRelayBootstrapPosts([
    {
      hash: "hash-old",
      itemHash: "item-old",
      address: "0xabc",
      ref: "simple-todo-bootstrap",
      type: "relay-bootstrap-v2",
      time: now / 1000,
      content: {
        peerId: "12D3KooWOld",
        updatedAt: now - 1_000,
        multiaddrs: [
          "/dns4/relay-old.example.com/tcp/443/tls/ws/p2p/12D3KooWOld",
        ],
      },
    },
    {
      hash: "hash-new",
      itemHash: "item-new",
      address: "0xabc",
      ref: "simple-todo-bootstrap",
      type: "relay-bootstrap-v2",
      time: now / 1000,
      content: {
        peerId: "12D3KooWNew",
        updatedAt: now,
        multiaddrs: [
          "/dns4/relay-new.example.com/tcp/443/tls/ws/p2p/12D3KooWNew",
        ],
      },
    },
    {
      hash: "hash-other",
      itemHash: "item-other",
      address: "0xdef",
      ref: "simple-todo-bootstrap",
      type: "relay-bootstrap-v2",
      time: now / 1000,
      content: {
        peerId: "12D3KooWOther",
        updatedAt: now,
        multiaddrs: [
          "/dns4/relay-other.example.com/tcp/443/tls/ws/p2p/12D3KooWOther",
        ],
      },
    },
  ]);

  assert.deepEqual(
    posts.map((post) => post.itemHash),
    ["item-new", "item-other"],
  );
});

test("relayBootstrapTrustMode distinguishes wallet-signed and dual-key records", () => {
  assert.equal(
    relayBootstrapTrustMode({
      peerId: "12D3KooWWallet",
      multiaddrs: [
        "/dns4/relay-wallet.example.com/tcp/443/tls/ws/p2p/12D3KooWWallet",
      ],
      updatedAt: 1,
    }),
    "wallet-signed",
  );

  assert.equal(
    relayBootstrapTrustMode({
      peerId: "12D3KooWProof",
      multiaddrs: [
        "/dns4/relay-proof.example.com/tcp/443/tls/ws/p2p/12D3KooWProof",
      ],
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
          multiaddrs: [
            "/dns4/relay-proof.example.com/tcp/443/tls/ws/p2p/12D3KooWProof",
          ],
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
            hash: "hash-wallet",
            item_hash: "item-wallet",
            address: "0xwallet",
            type: "relay-bootstrap-v2",
            ref: "simple-todo-bootstrap",
            content: {
              peerId: "12D3KooWWallet",
              updatedAt: now,
              multiaddrs: [
                "/dns4/relay-wallet.example.com/tcp/443/tls/ws/p2p/12D3KooWWallet",
              ],
              browserMultiaddrs: [
                "/dns4/relay-wallet.example.com/tcp/443/tls/ws/p2p/12D3KooWWallet",
              ],
            },
          },
        ],
      };
    },
  });

  assert.deepEqual(
    await discoverAlephBootstrapMultiaddrs({
      fetch,
      requireDualKeyAttestation: true,
    }),
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
    multiaddrs: [
      "/dns4/relay-proof.example.com/tcp/443/tls/ws/p2p/12D3KooWProof",
    ],
    browserMultiaddrs: [
      "/dns4/relay-proof.example.com/tcp/443/tls/ws/p2p/12D3KooWProof",
    ],
    registrationId: "relay:proof",
    profile: "orbitdb-relay",
    version: "0.4.0",
    updatedAt: 200,
    signer,
  });

  assert.equal(
    (await verifyRelayBootstrapAuthorization(authorization)).ok,
    true,
  );
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
    multiaddrs: [
      "/dns4/relay-proof.example.com/tcp/443/tls/ws/p2p/12D3KooWProof",
    ],
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
    signer,
  });

  assert.equal(proof.payload.multiaddrs, undefined);
  assert.equal(proof.payload.browserMultiaddrs, undefined);
  assert.equal(
    proof.payload.multiaddrsHash,
    relayBootstrapMultiaddrsHash(addrs),
  );

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
    multiaddrs: [
      "/dns4/relay-proof.example.com/tcp/443/tls/ws/p2p/12D3KooWProof",
    ],
    updatedAt: 200,
    signer,
  });

  const verified = await verifyRelayBootstrapDualKeyContent({
    peerId: "12D3KooWProof",
    multiaddrs: [
      "/dns4/relay-proof.example.com/tcp/443/tls/ws/p2p/12D3KooWProof",
    ],
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

test("filterRelayBootstrapPostsByRegistration keeps only the named registrations", () => {
  const posts = [
    { hash: "a", content: { registrationId: "relay:orbitdb-relay:orbitdb-relay" } },
    { hash: "b", content: { registrationId: "relay:orbitdb-relay:simple-todo-e2e-7f2" } },
    { hash: "c", content: {} },
    { hash: "d", content: null },
  ];

  assert.deepEqual(
    filterRelayBootstrapPostsByRegistration(posts, "relay:orbitdb-relay:orbitdb-relay").map(
      (post) => post.hash,
    ),
    ["a"],
  );

  // A list, for a consumer that runs more than one relay of its own.
  assert.deepEqual(
    filterRelayBootstrapPostsByRegistration(posts, [
      "relay:orbitdb-relay:orbitdb-relay",
      "relay:orbitdb-relay:simple-todo-e2e-7f2",
    ]).map((post) => post.hash),
    ["a", "b"],
  );

  // No scope means the whole channel: the previous behaviour, and the right
  // one for a consumer that wants to see what is out there.
  assert.equal(filterRelayBootstrapPostsByRegistration(posts).length, 4);
  assert.equal(filterRelayBootstrapPostsByRegistration(posts, "  ").length, 4);
});

test("discoverAlephBootstrapMultiaddrs can be scoped to one registration", async () => {
  // The case this exists for: an E2E run's throwaway relay is alive, fresh and
  // registered under the same profile as the production one. Profile alone
  // cannot tell them apart, and the throwaway becomes permanent dial noise the
  // moment its VM is erased — nobody can FORGET the post afterwards.
  const now = Date.now();
  const fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        posts: [
          {
            hash: "hash-prod",
            type: "relay-bootstrap-v2",
            ref: "simple-todo-bootstrap",
            content: {
              peerId: "12D3KooWProd",
              profile: "orbitdb-relay",
              registrationId: "relay:orbitdb-relay:orbitdb-relay",
              updatedAt: now,
              browserMultiaddrs: [
                "/dns4/relay-prod.example.com/tcp/443/tls/ws/p2p/12D3KooWProd",
              ],
            },
          },
          {
            hash: "hash-e2e",
            type: "relay-bootstrap-v2",
            ref: "simple-todo-bootstrap",
            content: {
              peerId: "12D3KooWE2E",
              profile: "orbitdb-relay",
              registrationId: "relay:orbitdb-relay:simple-todo-e2e-7f2",
              updatedAt: now,
              browserMultiaddrs: [
                "/dns4/relay-e2e.example.com/tcp/443/tls/ws/p2p/12D3KooWE2E",
              ],
            },
          },
        ],
      };
    },
  });

  assert.deepEqual(
    await discoverAlephBootstrapMultiaddrs({
      fetch,
      profile: "orbitdb-relay",
      registrationId: "relay:orbitdb-relay:orbitdb-relay",
    }),
    ["/dns4/relay-prod.example.com/tcp/443/tls/ws/p2p/12D3KooWProd"],
  );

  // Without the scope both come back — which is what made the scope necessary.
  assert.equal(
    (await discoverAlephBootstrapMultiaddrs({ fetch, profile: "orbitdb-relay" })).length,
    2,
  );
});
