import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const REFRESH = fileURLToPath(
  new URL("../reference/orbitdb-relay/rootfs/orbitdb-relay-autotls-refresh.py", import.meta.url),
);
const ZONE = "k51example.libp2p.direct";

async function secureAddrs(env: Record<string, string>) {
  const program = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("refresh", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
env = json.loads(sys.argv[2])
print(json.dumps({
    "addrs": module.build_secure_addrs(env, sys.argv[3]),
    "hosts": module.secure_hosts(env, sys.argv[3]),
}))
`;
  const { stdout } = await execFileAsync("python3", ["-c", program, REFRESH, JSON.stringify(env), ZONE]);
  return JSON.parse(stdout) as { addrs: string[]; hosts: string[] };
}

const ENV = {
  PUBLIC_IPV4: "37.114.50.44",
  PUBLIC_IPV6: "2a0e:97c0:3e3:54b:3:c294:17eb:e1f1",
  EXTERNAL_RELAY_WS_PORT: "33762",
  RELAY_WS_PORT: "9092",
};

test("a relay kept off IPv6 gets no AutoTLS address or certificate name for its IPv6", async () => {
  const { addrs, hosts } = await secureAddrs({ ...ENV, RELAY_DISABLE_IPV6: "1" });
  assert.deepEqual(addrs, [
    `/ip4/37.114.50.44/tcp/33762/tls/sni/37-114-50-44.${ZONE}/ws`,
    `/dns4/37-114-50-44.${ZONE}/tcp/33762/tls/ws`,
  ]);
  assert.deepEqual(hosts, [`37-114-50-44.${ZONE}`]);
});

test("a relay that announces IPv6 keeps its IPv6 AutoTLS addresses on the internal port", async () => {
  const { addrs } = await secureAddrs({ ...ENV, RELAY_DISABLE_IPV6: "0" });
  assert.ok(addrs.includes(`/dns6/2a0e-97c0-3e3-54b-3-c294-17eb-e1f1.${ZONE}/tcp/9092/tls/ws`));
});
