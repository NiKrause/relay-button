#!/usr/bin/env python3
import os
import re
import subprocess
import time
from typing import Iterable


ENV_FILE = os.environ.get("ENV_FILE", "/etc/default/uc-go-peer")
READY_FILE = os.environ.get("READY_FILE", "/etc/default/uc-go-peer.ready")
AUTOTLS_READY_FILE = os.environ.get("AUTOTLS_READY_FILE", "/etc/default/uc-go-peer.autotls-ready")
AUTOTLS_ZONE_FILE = os.environ.get("AUTOTLS_ZONE_FILE", "/etc/default/uc-go-peer.autotls-zone")
AUTOTLS_HOSTS_FILE = os.environ.get("AUTOTLS_HOSTS_FILE", "/etc/default/uc-go-peer.autotls-hosts")
SERVICE_NAME = os.environ.get("SERVICE_NAME", "uc-go-peer.service")
WAIT_TIMEOUT_SECONDS = int(os.environ.get("AUTOTLS_WAIT_TIMEOUT_SECONDS", "900"))
WAIT_INTERVAL_SECONDS = float(os.environ.get("AUTOTLS_WAIT_INTERVAL_SECONDS", "5"))
WS_BACKEND_PORT = os.environ.get("WS_BACKEND_PORT", "9097").strip()


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


def dedupe(sequence: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    values: list[str] = []
    for item in sequence:
        if item and item not in seen:
            seen.add(item)
            values.append(item)
    return values


def wait_for_exact_hosts(ws_port: str) -> tuple[str, list[str], list[str]]:
    deadline = time.monotonic() + WAIT_TIMEOUT_SECONDS
    regex = re.compile(rf"(/(?:ip4|ip6)/[^ ]+/tcp/{re.escape(ws_port)}/tls/sni/([^/]+)/ws)")
    zone_regex = re.compile(r'identifier": "\\*\.([^"]+)"')
    last_error = "AutoTLS websocket hostnames not advertised yet"

    while time.monotonic() < deadline:
        result = subprocess.run(
            ["journalctl", "-u", SERVICE_NAME, "-n", "400", "--no-pager"],
            capture_output=True,
            text=True,
            check=False,
        )
        output = result.stdout
        pairs = regex.findall(output)
        addrs = dedupe([pair[0] for pair in pairs])
        hosts = dedupe([pair[1] for pair in pairs])
        zone_match = zone_regex.search(output)
        zone = zone_match.group(1) if zone_match else ""
        if zone and hosts:
            return zone, hosts, addrs
        if hosts:
            return "", hosts, addrs
        if result.stderr.strip():
            last_error = result.stderr.strip()
        time.sleep(WAIT_INTERVAL_SECONDS)

    raise RuntimeError(last_error)


def main() -> None:
    if not os.path.exists(READY_FILE):
        raise SystemExit(f"missing ready file: {READY_FILE}")

    env_values = parse_env_file(ENV_FILE)
    ws_port = env_values.get("GO_PEER_WSS_PORT", "").strip() or WS_BACKEND_PORT
    if not ws_port:
        raise RuntimeError("missing GO_PEER_WSS_PORT in environment file")

    proxy_hostname = env_values.get("PROXY_HOSTNAME", "").strip()

    zone, exact_hosts, exact_logged_addrs = wait_for_exact_hosts(ws_port)
    if not exact_hosts:
        raise RuntimeError("no AutoTLS websocket hostnames found in logs")

    existing = [entry.strip() for entry in env_values.get("LIBP2P_ANNOUNCE_ADDRS", "").split(",") if entry.strip()]
    wildcard_filtered = [entry for entry in existing if "/tls/sni/*." not in entry]
    exact_announces: list[str] = list(exact_logged_addrs)

    if proxy_hostname:
        exact_announces.append(f"/dns4/{proxy_hostname}/tcp/443/tls/ws")
        exact_announces.append(f"/dns6/{proxy_hostname}/tcp/443/tls/ws")

    merged = dedupe(wildcard_filtered + exact_announces)
    announce_value = ",".join(merged)
    write_env_var(ENV_FILE, "LIBP2P_ANNOUNCE_ADDRS", announce_value)
    if zone:
        write_env_var(ENV_FILE, "AUTOTLS_SERVING_ZONE", zone)

    with open(AUTOTLS_HOSTS_FILE, "w", encoding="utf-8") as handle:
        for host in exact_hosts:
            handle.write(f"{host}\n")
    if zone:
        with open(AUTOTLS_ZONE_FILE, "w", encoding="utf-8") as handle:
            handle.write(f"{zone}\n")

    service_restarted = False
    if env_values.get("LIBP2P_ANNOUNCE_ADDRS", "") != announce_value:
        subprocess.run(["systemctl", "restart", SERVICE_NAME], check=True)
        service_restarted = True

    open(AUTOTLS_READY_FILE, "a", encoding="utf-8").close()
    print(f"Updated LIBP2P_ANNOUNCE_ADDRS={announce_value}")
    if service_restarted:
        print(f"Restarted {SERVICE_NAME} after AutoTLS hostname refresh")


if __name__ == "__main__":
    main()
