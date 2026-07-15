import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const describeScript = fileURLToPath(
  new URL(
    "../reference/uc-go-peer/rootfs/uc-go-peer-describe.py",
    import.meta.url,
  ),
);

test("uc-go-peer metadata preserves libp2p certhashes in public browser addresses", async () => {
  const peerId = "12D3KooWTestPeer";
  const webtransportHash = "uEiWebTransportHash";
  const webrtcHash = "uEiWebRtcHash";
  const program = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("uc_go_peer_describe", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
result = module.build_probe_multiaddrs(
    {
        "PUBLIC_IPV4": "203.0.113.10",
        "PUBLIC_IPV6": "2001:db8::10",
        "EXTERNAL_RELAY_UDP_PORT": "40169",
    },
    "${peerId}",
    [
        "/ip4/127.0.0.1/udp/9095/quic-v1/webtransport/certhash/${webtransportHash}",
        "/ip4/127.0.0.1/udp/9095/webrtc-direct/certhash/${webrtcHash}",
    ],
)
print(json.dumps(result))
`;
  const { stdout } = await execFileAsync("python3", [
    "-c",
    program,
    describeScript,
  ]);
  const result = JSON.parse(stdout);

  assert.deepEqual(result.webtransport_multiaddrs, [
    `/ip4/203.0.113.10/udp/40169/quic-v1/webtransport/certhash/${webtransportHash}/p2p/${peerId}`,
    `/ip6/2001:db8::10/udp/40169/quic-v1/webtransport/certhash/${webtransportHash}/p2p/${peerId}`,
  ]);
  assert.deepEqual(result.webrtc_direct_multiaddrs, [
    `/ip4/203.0.113.10/udp/40169/webrtc-direct/certhash/${webrtcHash}/p2p/${peerId}`,
    `/ip6/2001:db8::10/udp/40169/webrtc-direct/certhash/${webrtcHash}/p2p/${peerId}`,
  ]);
});

test("uc-go-peer metadata does not invent direct browser addresses without certhashes", async () => {
  const program = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("uc_go_peer_describe", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
result = module.build_probe_multiaddrs(
    {"PUBLIC_IPV4": "203.0.113.10", "EXTERNAL_RELAY_UDP_PORT": "40169"},
    "12D3KooWTestPeer",
    ["/ip4/127.0.0.1/udp/9095/quic-v1/webtransport"],
)
print(json.dumps(result))
`;
  const { stdout } = await execFileAsync("python3", [
    "-c",
    program,
    describeScript,
  ]);
  const result = JSON.parse(stdout);

  assert.deepEqual(result.webtransport_multiaddrs, []);
  assert.deepEqual(result.webrtc_direct_multiaddrs, []);
});
