import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const describeScript = fileURLToPath(
  new URL("../reference/uc-go-peer/rootfs/uc-go-peer-describe.py", import.meta.url),
);

// describe.py only advertises an AutoTLS address once a CA-validated TLS
// handshake proves its certificate serves. That handshake is a loopback dial,
// so it needs the port the listener is bound to inside the guest -- and the
// announced port is not that one. Aleph publishes every port under a
// different number: the relay binds 9097 while the multiaddr advertises the
// mapped port, and the translation happens in the host's NAT, which loopback
// never traverses.
//
// Measured on the live relay 62.141.40.252: 127.0.0.1:64861 refused the
// connection, 127.0.0.1:9097 served a valid *.libp2p.direct certificate, and
// only 9097 was listening. Every AutoTLS address was therefore dropped, which
// is why no uc-go-peer registration has ever carried one.
async function portsTried(addr: string, backendPort: string) {
  const program = [
    "import importlib.util, json, sys",
    'spec = importlib.util.spec_from_file_location("d", sys.argv[1])',
    "m = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(m)",
    "tried = []",
    "m.tls_endpoint_serves = lambda host, port: (tried.append((host, port)), False)[1]",
    `m.autotls_cert_serves([${JSON.stringify(addr)}], ${backendPort})`,
    "print(json.dumps(tried))",
  ].join("\n");
  const { stdout } = await execFileAsync("python3", ["-c", program, describeScript]);
  return JSON.parse(stdout) as [string, number][];
}

const HOST = "62-141-40-252.kzwfwjn5ji4pupsooyhz4s566awzjkhg0r6jcqz5pfbhbwwm638931yehx9i980.libp2p.direct";
const ADDR = "/dns4/" + HOST + "/tcp/64861/tls/ws/p2p/16Uiu2HAmBxr7fST3";

test("the certificate gate falls back to the port the listener is bound to", async () => {
  const tried = await portsTried(ADDR, "9097");
  assert.deepEqual(tried, [
    [HOST, 64861],
    [HOST, 9097],
  ]);
});

test("the announced port is still tried first, so a profile binding it does not regress", async () => {
  const tried = await portsTried(ADDR, "9097");
  assert.deepEqual(tried[0], [HOST, 64861]);
});

test("no backend port means the old behaviour, not a crash", async () => {
  const tried = await portsTried(ADDR, "None");
  assert.deepEqual(tried, [[HOST, 64861]]);
});

test("a backend port equal to the announced one is not dialled twice", async () => {
  const tried = await portsTried("/dns4/" + HOST + "/tcp/9097/tls/ws/p2p/x", "9097");
  assert.deepEqual(tried, [[HOST, 9097]]);
});
