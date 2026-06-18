#!/usr/bin/env python3
import json
import os
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


def wait_for_autotls_zone() -> str:
    deadline = time.monotonic() + WAIT_TIMEOUT_SECONDS
    last_error = "metrics endpoint never became ready"

    while time.monotonic() < deadline:
        try:
            health = fetch_json("/health")
            payload = fetch_json("/multiaddrs")
            zone = health.get("autoTlsServingZone")
            all_addrs = payload.get("all")
            if (
                isinstance(zone, str)
                and zone
                and isinstance(all_addrs, list)
                and any(isinstance(addr, str) and "/tls/ws" in addr for addr in all_addrs)
            ):
                return zone
            last_error = "AutoTLS secure websocket multiaddrs not advertised yet"
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            last_error = str(error)

        time.sleep(WAIT_INTERVAL_SECONDS)

    raise RuntimeError(last_error)


def build_secure_addrs(env_values: dict[str, str], zone: str) -> list[str]:
    ws_port = env_values.get("EXTERNAL_RELAY_WS_PORT", "").strip()
    if not ws_port:
        raise RuntimeError("missing EXTERNAL_RELAY_WS_PORT in environment file")

    addrs: list[str] = []

    public_ipv4 = env_values.get("PUBLIC_IPV4", "").strip()
    if public_ipv4:
        host4 = ipv4_domain(public_ipv4, zone)
        addrs.append(f"/ip4/{public_ipv4}/tcp/{ws_port}/tls/sni/{host4}/ws")
        addrs.append(f"/dns4/{host4}/tcp/{ws_port}/tls/ws")

    public_ipv6 = env_values.get("PUBLIC_IPV6", "").strip()
    if public_ipv6:
        host6 = ipv6_domain(public_ipv6, zone)
        addrs.append(f"/ip6/{public_ipv6}/tcp/{ws_port}/tls/sni/{host6}/ws")
        addrs.append(f"/dns6/{host6}/tcp/{ws_port}/tls/ws")

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
    secure_addrs = build_secure_addrs(env_values, zone)
    exact_hosts = secure_hosts(env_values, zone)
    metrics_host = metrics_https_public_host(env_values, zone)
    current_value = env_values.get("VITE_APPEND_ANNOUNCE", "")
    current_metrics_host = env_values.get("METRICS_HTTPS_PUBLIC_HOST", "").strip()
    merged = dedupe(
        [normalize_addr(addr) for addr in current_value.split(",") if addr.strip()] + secure_addrs
    )
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

    open(AUTOTLS_READY_FILE, "a", encoding="utf-8").close()
    print(f"Updated VITE_APPEND_ANNOUNCE={announce_value}")


if __name__ == "__main__":
    main()
