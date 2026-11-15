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
  "../reference/orbitdb-relay/rootfs/orbitdb-relay-configure.sh",
);

const ARGS = [
  "--public-ipv4", "1.2.3.4",
  "--public-ipv6", "2001:db8::5",
  "--tcp-port", "24010",
  "--ws-port", "24011",
  "--quic-port", "24014",
  "--proxy-hostname", "foo-bar-baz-qux.2n6.me",
  "--no-start",
];

async function configure(extraEnv: Record<string, string> = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "orbitdb-relay-configure-"));
  const envFile = path.join(dir, "orbitdb-relay");
  const env = {
    ...process.env,
    ENV_FILE: envFile,
    READY_FILE: path.join(dir, "ready"),
    AUTOTLS_READY_FILE: path.join(dir, "autotls-ready"),
    AUTOTLS_ZONE_FILE: path.join(dir, "autotls-zone"),
    AUTOTLS_HOSTS_FILE: path.join(dir, "autotls-hosts"),
    CADDY_READY_FILE: path.join(dir, "caddy-ready"),
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
    announce: (values.get("VITE_APPEND_ANNOUNCE") ?? "").split(",").filter(Boolean),
    values,
  };
}

test("orbitdb-relay announces no raw IPv6 address and does not listen on IPv6 by default", async () => {
  // Inbound IPv6 does not reach the relay's ports on Aleph (measured with
  // tcpdump inside a running relay), so a raw /ip6 address is a dead one.
  const { announce, values } = await configure();

  assert.deepEqual(
    announce.filter((addr) => addr.startsWith("/ip6/")),
    [],
  );
  // libp2p announces the global IPv6 of every interface it listens on, so
  // dropping the announce entries alone would not keep the address out.
  assert.equal(values.get("RELAY_DISABLE_IPV6"), "1");
  // The 2n6 proxy is the IPv6 path that works, and stays.
  assert.ok(announce.includes("/dns6/foo-bar-baz-qux.2n6.me/tcp/443/tls/ws"));
  assert.ok(announce.includes("/ip4/1.2.3.4/tcp/24010"));
  assert.equal(values.get("PUBLIC_IPV6"), "2001:db8::5");
});

test("ANNOUNCE_PUBLIC_IPV6=1 brings the IPv6 addresses back on the internal ports", async () => {
  const { announce, values } = await configure({ ANNOUNCE_PUBLIC_IPV6: "1" });

  assert.deepEqual(
    announce.filter((addr) => addr.startsWith("/ip6/")),
    [
      "/ip6/2001:db8::5/tcp/9091",
      "/ip6/2001:db8::5/tcp/9092/ws",
      "/ip6/2001:db8::5/udp/9094/quic-v1",
    ],
  );
  assert.equal(values.get("RELAY_DISABLE_IPV6"), "0");
});
