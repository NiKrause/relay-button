#!/usr/bin/env python3
import json
import os
import socket
import ssl
import subprocess
import time
import urllib.error
import urllib.request
from typing import Iterable


ENV_FILE = os.environ.get("ENV_FILE", "/etc/default/orbitdb-relay")
READY_FILE = os.environ.get("READY_FILE", "/etc/default/orbitdb-relay.ready")
AUTOTLS_READY_FILE = os.environ.get(
    "AUTOTLS_READY_FILE", "/etc/default/orbitdb-relay.autotls-ready"
)
AUTOTLS_ZONE_FILE = os.environ.get("AUTOTLS_ZONE_FILE", "/etc/default/orbitdb-relay.autotls-zone")
AUTOTLS_HOSTS_FILE = os.environ.get("AUTOTLS_HOSTS_FILE", "/etc/default/orbitdb-relay.autotls-hosts")
AUTOTLS_CADDY_READY_FILE = os.environ.get(
    "AUTOTLS_CADDY_READY_FILE", "/etc/default/orbitdb-relay.caddy-ready"
)
SERVICE_NAME = os.environ.get("SERVICE_NAME", "orbitdb-relay.service")
CADDY_SERVICE = os.environ.get("CADDY_SERVICE", "caddy.service")
CADDYFILE = os.environ.get("CADDYFILE", "/etc/caddy/Caddyfile")
METRICS_PORT = int(os.environ.get("METRICS_PORT", "9090"))
WAIT_TIMEOUT_SECONDS = int(os.environ.get("AUTOTLS_WAIT_TIMEOUT_SECONDS", "900"))
WAIT_INTERVAL_SECONDS = float(os.environ.get("AUTOTLS_WAIT_INTERVAL_SECONDS", "5"))
TLS_PROBE_TIMEOUT_SECONDS = float(os.environ.get("AUTOTLS_TLS_PROBE_TIMEOUT_SECONDS", "5"))


def fetch_json(path: str) -> dict:
    url = f"http://127.0.0.1:{METRICS_PORT}{path}"
    with urllib.request.urlopen(url, timeout=5) as response:
        return json.loads(response.read().decode("utf-8"))


def parse_env_file(path: str) -> dict[str, str]:
    values: dict[str, str] = {}
    if not os.path.exists(path):
        return values

    with open(path, encoding="utf-8") as handle:
        for line in handle:
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue
            key, value = stripped.split("=", 1)
            values[key.strip()] = value.strip()
    return values


def write_env_var(path: str, key: str, value: str) -> None:
    lines: list[str] = []
    replaced = False

    if os.path.exists(path):
        with open(path, encoding="utf-8") as handle:
            lines = handle.readlines()

    with open(path, "w", encoding="utf-8") as handle:
        for line in lines:
            stripped = line.lstrip()
            if stripped.startswith(f"{key}=") or stripped.startswith(f"#{key}="):
                handle.write(f"{key}={value}\n")
                replaced = True
            else:
                handle.write(line)

        if not replaced:
            handle.write(f"{key}={value}\n")


def normalize_addr(addr: str) -> str:
    parts = addr.strip().split("/")
    if len(parts) >= 3 and parts[-2] == "p2p":
        return "/".join(parts[:-2])
    return addr.strip()


def dedupe(sequence: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    values: list[str] = []
    for item in sequence:
        if item and item not in seen:
            seen.add(item)
            values.append(item)
    return values


def ipv4_domain(ipv4: str, zone: str) -> str:
    return f"{ipv4.replace('.', '-')}.{zone}"


def ipv6_domain(ipv6: str, zone: str) -> str:
    subdomain = ipv6.replace(":", "-")
    if subdomain.startswith("-"):
        subdomain = f"0{subdomain}"
    if subdomain.endswith("-"):
        subdomain = f"{subdomain}0"
    return f"{subdomain}.{zone}"


def listener_presents_certificate(port: str, server_name: str) -> bool:
    """Does the local WebSocket listener actually terminate TLS?

    This is the only question that matters before announcing a `/tls/...`
    address, and until this existed nothing asked it. The previous gate read
    `/multiaddrs` from the metrics endpoint and looked for a `/tls/ws` entry -
    but that list is the *announce* list, which is what this script writes. It
    confirmed its own output from the run before, so it passed on a relay whose
    WebSocket port had never spoken TLS in its life.

    The result on a live relay: `/ip4/.../tcp/52194/tls/sni/<host>/ws` announced
    for a port that answers a plaintext handshake with `101 Switching
    Protocols`. Browsers on an https origin got ERR_SSL_PROTOCOL_ERROR, and
    every peer paid a TLS timeout on every connect
    (see NiKrause/simple-todo#154).

    Opening a socket cannot be fooled that way.
    """
    context = ssl.create_default_context()
    # Asking whether *a* certificate is served, not whether it validates: the
    # probe runs against loopback while the certificate is issued for the public
    # AutoTLS hostname, so a chain check would fail on a healthy relay.
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE

    try:
        with socket.create_connection(("127.0.0.1", int(port)), TLS_PROBE_TIMEOUT_SECONDS) as raw:
            # SNI is not optional. Without `server_hostname` a name-based TLS
            # server has nothing to select a certificate by and aborts the
            # handshake - which made an earlier version of this probe report
            # "no TLS" for Caddy on 443, a port that demonstrably serves one.
            with context.wrap_socket(raw, server_hostname=server_name) as tls:
                return tls.getpeercert(binary_form=True) is not None
    except (OSError, ssl.SSLError, ValueError):
        return False


def wait_for_autotls_zone() -> str:
    deadline = time.monotonic() + WAIT_TIMEOUT_SECONDS
    last_error = "metrics endpoint never became ready"

    while time.monotonic() < deadline:
        try:
            health = fetch_json("/health")
            zone = health.get("autoTlsServingZone")
            if isinstance(zone, str) and zone:
                return zone
            last_error = "AutoTLS serving zone not published yet"
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            last_error = str(error)

        time.sleep(WAIT_INTERVAL_SECONDS)

    raise RuntimeError(last_error)


def build_secure_addrs(env_values: dict[str, str], zone: str) -> list[str]:
    ws_port = env_values.get("EXTERNAL_RELAY_WS_PORT", "").strip()
    if not ws_port:
        raise RuntimeError("missing EXTERNAL_RELAY_WS_PORT in environment file")

    # IPv4 is NAT/port-mapped, so it is advertised on the externally assigned
    # host port. IPv6 is globally routed with no NAT on the Aleph VM — reachable
    # directly on the internal listen port, while the mapped host port is closed
    # over IPv6. Advertise the IPv6 libp2p.direct AutoTLS addresses on the
    # internal WS port so AutoNAT/AutoTLS dial-backs actually reach the relay.
    ws_port_ipv6 = env_values.get("RELAY_WS_PORT", "").strip() or ws_port

    addrs: list[str] = []

    public_ipv4 = env_values.get("PUBLIC_IPV4", "").strip()
    if public_ipv4:
        host4 = ipv4_domain(public_ipv4, zone)
        addrs.append(f"/ip4/{public_ipv4}/tcp/{ws_port}/tls/sni/{host4}/ws")
        addrs.append(f"/dns4/{host4}/tcp/{ws_port}/tls/ws")

    public_ipv6 = env_values.get("PUBLIC_IPV6", "").strip()
    if public_ipv6:
        host6 = ipv6_domain(public_ipv6, zone)
        addrs.append(f"/ip6/{public_ipv6}/tcp/{ws_port_ipv6}/tls/sni/{host6}/ws")
        addrs.append(f"/dns6/{host6}/tcp/{ws_port_ipv6}/tls/ws")

    if not addrs:
        raise RuntimeError("missing PUBLIC_IPV4/PUBLIC_IPV6 in environment file")

    return addrs


def secure_hosts(env_values: dict[str, str], zone: str) -> list[str]:
    hosts: list[str] = []
    public_ipv4 = env_values.get("PUBLIC_IPV4", "").strip()
    if public_ipv4:
        hosts.append(ipv4_domain(public_ipv4, zone))

    public_ipv6 = env_values.get("PUBLIC_IPV6", "").strip()
    if public_ipv6:
        hosts.append(ipv6_domain(public_ipv6, zone))

    return dedupe(hosts)


def metrics_https_public_host(env_values: dict[str, str], zone: str) -> str | None:
    public_ipv4 = env_values.get("PUBLIC_IPV4", "").strip()
    if public_ipv4:
        return ipv4_domain(public_ipv4, zone)

    public_ipv6 = env_values.get("PUBLIC_IPV6", "").strip()
    if public_ipv6:
        return ipv6_domain(public_ipv6, zone)

    return None


def main() -> None:
    if not os.path.exists(READY_FILE):
        raise SystemExit(f"missing ready file: {READY_FILE}")

    env_values = parse_env_file(ENV_FILE)
    zone = wait_for_autotls_zone()

    # Announce a TLS address only where something terminates TLS. The relay
    # listens plaintext on RELAY_WS_PORT and Caddy terminates on 443; if AutoTLS
    # has not taken over that listener, the libp2p.direct addresses would be a
    # promise the port cannot keep. Caddy's own 443 address is written elsewhere
    # and is unaffected by this - it keeps working either way.
    internal_ws_port = env_values.get("RELAY_WS_PORT", "").strip()
    autotls_hostname = metrics_https_public_host(env_values, zone)
    autotls_serving = bool(internal_ws_port and autotls_hostname) and listener_presents_certificate(
        internal_ws_port, autotls_hostname
    )

    if autotls_serving:
        secure_addrs = build_secure_addrs(env_values, zone)
    else:
        secure_addrs = []
        print(
            f"AutoTLS is not terminating TLS on 127.0.0.1:{internal_ws_port or '<unset>'} - "
            "skipping the libp2p.direct announce addresses. Peers keep the Caddy "
            "address on 443, which is served by a separate process."
        )
    exact_hosts = secure_hosts(env_values, zone) if autotls_serving else []
    metrics_host = metrics_https_public_host(env_values, zone)
    current_value = env_values.get("VITE_APPEND_ANNOUNCE", "")
    current_metrics_host = env_values.get("METRICS_HTTPS_PUBLIC_HOST", "").strip()
    previous = [normalize_addr(addr) for addr in current_value.split(",") if addr.strip()]

    # Drop stale libp2p.direct entries when the probe says they are not served.
    # Without this the first bad run leaves them in the file forever - which is
    # how the live relay kept announcing a plaintext port across restarts.
    if not autotls_serving:
        previous = [addr for addr in previous if "libp2p.direct" not in addr]

    merged = dedupe(previous + secure_addrs)
    announce_changed = current_value.split(",") != merged
    metrics_host_changed = bool(metrics_host) and current_metrics_host != metrics_host

    announce_value = ",".join(merged)
    write_env_var(ENV_FILE, "VITE_APPEND_ANNOUNCE", announce_value)
    write_env_var(ENV_FILE, "AUTOTLS_SERVING_ZONE", zone)
    if metrics_host:
        write_env_var(ENV_FILE, "METRICS_HTTPS_PUBLIC_HOST", metrics_host)

    with open(AUTOTLS_HOSTS_FILE, "w", encoding="utf-8") as handle:
        for host in exact_hosts:
            handle.write(f"{host}\n")
    with open(AUTOTLS_ZONE_FILE, "w", encoding="utf-8") as handle:
        handle.write(f"{zone}\n")

    if announce_changed or metrics_host_changed:
        subprocess.run(["systemctl", "restart", SERVICE_NAME], check=True)
    else:
        print("AutoTLS secure external announce addresses already present")

    if env_values.get("PROXY_HOSTNAME", "").strip():
        open(AUTOTLS_CADDY_READY_FILE, "a", encoding="utf-8").close()
        if os.path.exists(CADDYFILE):
            subprocess.run(["systemctl", "enable", CADDY_SERVICE], check=False)
            subprocess.run(["systemctl", "restart", CADDY_SERVICE], check=False)
    elif os.path.exists(AUTOTLS_CADDY_READY_FILE):
        os.remove(AUTOTLS_CADDY_READY_FILE)

    # The ready file is what stops this unit from running again
    # (ConditionPathExists=! in the unit), so it may only be written once the
    # AutoTLS addresses are actually announced. Writing it unconditionally is
    # what made a single early probe final: AutoTLS needs a minute or two to
    # fetch its certificate, the probe correctly found a plaintext port before
    # that, marked itself done - and the certificate that arrived afterwards was
    # never announced. The timer beside this unit retries until it is here.
    if autotls_serving:
        open(AUTOTLS_READY_FILE, "a", encoding="utf-8").close()
    else:
        print(
            "Not marking AutoTLS ready - no TLS on the listener yet. "
            f"{os.path.basename(AUTOTLS_READY_FILE)} stays absent so the timer retries."
        )

    print(f"Updated VITE_APPEND_ANNOUNCE={announce_value}")


if __name__ == "__main__":
    main()
