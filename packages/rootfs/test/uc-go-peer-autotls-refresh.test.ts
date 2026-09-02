import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const refreshScript = fileURLToPath(
  new URL(
    "../reference/uc-go-peer/rootfs/uc-go-peer-autotls-refresh.py",
    import.meta.url,
  ),
);

const LOADER = [
  "import importlib.util, json, sys",
  'spec = importlib.util.spec_from_file_location("uc_go_peer_autotls_refresh", sys.argv[1])',
  "module = importlib.util.module_from_spec(spec)",
  "spec.loader.exec_module(module)",
].join("\n");

async function runPython(body: string) {
  const { stdout, stderr } = await execFileAsync("python3", [
    "-c",
    LOADER + "\n" + body,
    refreshScript,
  ]);
  return { result: JSON.parse(stdout), stderr };
}

// The relay logs its websocket listeners on the port it actually binds inside
// the guest. Aleph publishes that port under a different number, so the
// address as logged is not the address anyone can reach.
const BACKEND_PORT = "9097";
const MAPPED_PORT = "24013";
const SNI_HOST =
  "65-108-233-158.kzwfwjn5ji4purpcgpxdj9rvsjh6a8cn0px81sedw0d36uxv7mylta5huw2rm2a.libp2p.direct";
const LOGGED_WSS = "/ip4/65.108.233.158/tcp/" + BACKEND_PORT + "/tls/sni/" + SNI_HOST + "/ws";

test("AutoTLS websocket is announced on the mapped port, not the backend port", async () => {
  const { result } = await runPython(
    "print(json.dumps(module.build_announce_addrs(" +
      JSON.stringify(["/ip4/65.108.233.158/tcp/24012", "/ip4/65.108.233.158/tcp/" + BACKEND_PORT + "/tls/sni/*.libp2p.direct/ws"]) +
      ", " +
      JSON.stringify([LOGGED_WSS]) +
      ', "' + BACKEND_PORT + '", "' + MAPPED_PORT + '")))',
  );

  // The regression: the logged address went out verbatim, so browsers were
  // handed 9097 — closed from the internet — while the reachable 24013
  // carried the very same listener.
  assert.deepEqual(result, [
    "/ip4/65.108.233.158/tcp/24012",
    "/ip4/65.108.233.158/tcp/" + MAPPED_PORT + "/tls/sni/" + SNI_HOST + "/ws",
  ]);
});

test("only the port segment is rewritten, not a matching number inside an IPv6 address", async () => {
  const logged = "/ip6/2a01:9097:1::1/tcp/" + BACKEND_PORT + "/tls/sni/" + SNI_HOST + "/ws";
  const { result } = await runPython(
    "print(json.dumps(module.build_announce_addrs([], " +
      JSON.stringify([logged]) +
      ', "' + BACKEND_PORT + '", "' + MAPPED_PORT + '")))',
  );

  assert.deepEqual(result, [
    "/ip6/2a01:9097:1::1/tcp/" + MAPPED_PORT + "/tls/sni/" + SNI_HOST + "/ws",
  ]);
});

test("a guest without port mapping announces the backend port unchanged", async () => {
  const { result } = await runPython(
    "print(json.dumps(module.build_announce_addrs([], " +
      JSON.stringify([LOGGED_WSS]) +
      ', "' + BACKEND_PORT + '", "' + BACKEND_PORT + '")))',
  );

  assert.deepEqual(result, [LOGGED_WSS]);
});

test("a missing EXTERNAL_RELAY_WS_PORT says so on stderr instead of announcing silently", async () => {
  const { result, stderr } = await runPython(
    'print(json.dumps(module.resolve_external_ws_port({"GO_PEER_WSS_PORT": "' +
      BACKEND_PORT +
      '"}, "' + BACKEND_PORT + '")))',
  );

  assert.equal(result, BACKEND_PORT);
  assert.match(stderr, /EXTERNAL_RELAY_WS_PORT is missing/);
  assert.match(stderr, /unreachable from outside the guest/);
});

test("EXTERNAL_RELAY_WS_PORT wins over the backend port and stays quiet", async () => {
  const { result, stderr } = await runPython(
    'print(json.dumps(module.resolve_external_ws_port({"EXTERNAL_RELAY_WS_PORT": "' +
      MAPPED_PORT +
      '"}, "' + BACKEND_PORT + '")))',
  );

  assert.equal(result, MAPPED_PORT);
  assert.equal(stderr, "");
});

test("the reverse-proxy hostname is still appended after the port translation", async () => {
  const { result } = await runPython(
    "print(json.dumps(module.build_announce_addrs([], " +
      JSON.stringify([LOGGED_WSS]) +
      ', "' + BACKEND_PORT + '", "' + MAPPED_PORT + '", "relay.example.org")))',
  );

  assert.deepEqual(result, [
    "/ip4/65.108.233.158/tcp/" + MAPPED_PORT + "/tls/sni/" + SNI_HOST + "/ws",
    "/dns4/relay.example.org/tcp/443/tls/ws",
    "/dns6/relay.example.org/tcp/443/tls/ws",
  ]);
});
