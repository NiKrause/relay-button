import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIGURE_SCRIPT = path.resolve(
  TEST_DIR,
  "../reference/uc-go-peer/rootfs/uc-go-peer-configure.sh",
);

const ARGS = [
  "--public-ipv4", "1.2.3.4",
  "--public-ipv6", "2001:db8::5",
  "--tcp-port", "24050",
  "--ws-port", "24051",
  "--udp-port", "24052",
  "--proxy-hostname", "foo-bar-baz-qux.2n6.me",
  "--no-start",
];

async function configure(extraEnv: Record<string, string> = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "uc-go-peer-configure-"));
  const envFile = path.join(dir, "orbitdb-relay");
  const env = {
    ...process.env,
    ENV_FILE: envFile,
    READY_FILE: path.join(dir, "ready"),
    AUTOTLS_READY_FILE: path.join(dir, "autotls-ready"),
    AUTOTLS_ZONE_FILE: path.join(dir, "autotls-zone"),
    AUTOTLS_HOSTS_FILE: path.join(dir, "autotls-hosts"),
    AUTOTLS_CADDY_READY_FILE: path.join(dir, "caddy-ready"),
    CADDYFILE: path.join(dir, "Caddyfile"),
    ...extraEnv,
  };
  const child = spawn("bash", [CONFIGURE_SCRIPT, ...ARGS], { env });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  assert.equal(code, 0, stderr);

  const values = new Map<string, string>();
  for (const line of (await readFile(envFile, "utf8")).split("\n")) {
    const index = line.indexOf("=");
    if (index > 0 && !line.startsWith("#")) values.set(line.slice(0, index), line.slice(index + 1));
  }
  await rm(dir, { recursive: true, force: true });
  return {
    announce: (values.get("LIBP2P_ANNOUNCE_ADDRS") ?? "").split(",").filter(Boolean),
    values,
  };
}

test("uc-go-peer announces no raw IPv6 address and keeps go-peer off IPv6 by default", async () => {
  // Aleph forwards ports for IPv4 only, so the mapped ports announced here do
  // not exist on IPv6, and inbound IPv6 does not reach the internal ones.
  const { announce, values } = await configure();

  assert.deepEqual(
    announce.filter((addr) => addr.startsWith("/ip6/")),
    [],
  );
  // go-peer reads this and leaves out its [::] listeners (go-libp2p would
  // announce the interface's IPv6 otherwise).
  assert.equal(values.get("LIBP2P_DISABLE_IPV6"), "1");
  assert.ok(announce.includes("/ip4/1.2.3.4/udp/24052/webrtc-direct"));
  assert.equal(values.get("PUBLIC_IPV6"), "2001:db8::5");
});

test("ANNOUNCE_PUBLIC_IPV6=1 brings the uc-go-peer IPv6 addresses back", async () => {
  const { announce, values } = await configure({ ANNOUNCE_PUBLIC_IPV6: "1" });

  assert.deepEqual(
    announce.filter((addr) => addr.startsWith("/ip6/")),
    [
      "/ip6/2001:db8::5/tcp/24050",
      "/ip6/2001:db8::5/tcp/24051/tls/sni/*.libp2p.direct/ws",
      "/ip6/2001:db8::5/udp/24052/quic-v1",
      "/ip6/2001:db8::5/udp/24052/quic-v1/webtransport",
      "/ip6/2001:db8::5/udp/24052/webrtc-direct",
    ],
  );
  assert.equal(values.get("LIBP2P_DISABLE_IPV6"), "0");
});
