#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
import subprocess
import time


ENV_FILE = os.environ.get("ENV_FILE", "/etc/default/uc-go-peer")
SERVICE_NAME = os.environ.get("SERVICE_NAME", "uc-go-peer.service")
WAIT_TIMEOUT_SECONDS = int(os.environ.get("DESCRIBE_WAIT_TIMEOUT_SECONDS", "240"))
WAIT_INTERVAL_SECONDS = float(os.environ.get("DESCRIBE_WAIT_INTERVAL_SECONDS", "2"))
AUTOTLS_EXTRA_WAIT_SECONDS = int(os.environ.get("DESCRIBE_AUTOTLS_EXTRA_WAIT_SECONDS", "120"))

PEER_ID_PATTERNS = [
    re.compile(r"PeerID:\s+(\S+)"),
    re.compile(r"Host created with PeerID:\s+(\S+)"),
]
LISTENING_PATTERN = re.compile(r"Listening on:\s+(\S+)/p2p/(\S+)")


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


def dedupe(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        if value and value not in seen:
            seen.add(value)
            result.append(value)
    return result


def append_peer_id(addr: str, peer_id: str) -> str:
    return addr if "/p2p/" in addr else f"{addr}/p2p/{peer_id}"


def browser_transport_suffixes(listening_addrs: list[str], transport: str) -> list[str]:
    """Return dial-critical transport suffixes advertised by the live libp2p host.

    WebTransport and WebRTC Direct addresses include a certificate hash generated
    by libp2p.  Reconstructing these addresses from only the public IP and port
    drops that hash and produces addresses browsers cannot dial.
    """
    marker = f"/{transport}/"
    suffixes: list[str] = []
    for addr in listening_addrs:
        normalized = addr.lower()
        marker_index = normalized.find(marker)
        if marker_index < 0:
            continue
        suffix = addr[marker_index:]
        if "/certhash/" not in suffix.lower():
            continue
        suffixes.append(suffix)
    return dedupe(suffixes)


def public_udp_multiaddrs(
    public_ipv4: str,
    public_ipv6: str,
    udp_port: str,
    suffixes: list[str],
    peer_id: str,
) -> list[str]:
    result: list[str] = []
    for suffix in suffixes:
        suffix_with_peer = append_peer_id(suffix, peer_id)
        if public_ipv4:
            result.append(f"/ip4/{public_ipv4}/udp/{udp_port}{suffix_with_peer}")
        if public_ipv6:
            result.append(f"/ip6/{public_ipv6}/udp/{udp_port}{suffix_with_peer}")
    return dedupe(result)


def parse_logs() -> tuple[str | None, list[str]]:
    result = subprocess.run(
        ["journalctl", "-u", SERVICE_NAME, "-n", "500", "--no-pager"],
        capture_output=True,
        text=True,
        check=False,
    )
    output = result.stdout or ""

    peer_id = None
    for line in output.splitlines():
        for pattern in PEER_ID_PATTERNS:
            match = pattern.search(line)
            if match:
                peer_id = match.group(1)

    logged_addrs = LISTENING_PATTERN.findall(output)
    if peer_id is None and logged_addrs:
        peer_id = logged_addrs[-1][1]

    listening_addrs = []
    for addr, logged_peer_id in logged_addrs:
        if peer_id is None or logged_peer_id == peer_id:
            listening_addrs.append(addr)

    return peer_id, dedupe(listening_addrs)


def build_probe_multiaddrs(env_values: dict[str, str], peer_id: str, listening_addrs: list[str]) -> dict[str, list[str]]:
    announce_addrs = [
        entry.strip()
        for entry in env_values.get("LIBP2P_ANNOUNCE_ADDRS", "").split(",")
        if entry.strip()
    ]
    probe_multiaddrs: list[str] = []
    direct_tcp_multiaddrs: list[str] = []
    autotls_multiaddrs: list[str] = []
    proxy_multiaddrs: list[str] = []
    webtransport_multiaddrs: list[str] = []
    webrtc_direct_multiaddrs: list[str] = []

    for addr in announce_addrs:
        if "/tcp/" in addr and "/tls/" not in addr and "/ws" not in addr:
            direct_tcp_multiaddrs.append(append_peer_id(addr, peer_id))

    ws_port = env_values.get("EXTERNAL_RELAY_WS_PORT", "").strip()
    for addr in listening_addrs:
        if "/tls/" not in addr or not addr.endswith("/ws"):
            continue

        dns_match = re.search(r"/dns[46]/([^/]+)/tcp/(\d+)/tls/ws$", addr)
        if dns_match:
            host = dns_match.group(1)
            autotls_multiaddrs.append(f"/dns4/{host}/tcp/{ws_port or dns_match.group(2)}/tls/ws/p2p/{peer_id}")
            autotls_multiaddrs.append(f"/dns6/{host}/tcp/{ws_port or dns_match.group(2)}/tls/ws/p2p/{peer_id}")
            continue

        sni_match = re.search(r"/tls/sni/([^/]+)/ws$", addr)
        if sni_match:
            host = sni_match.group(1)
            if ws_port:
                autotls_multiaddrs.append(f"/dns4/{host}/tcp/{ws_port}/tls/ws/p2p/{peer_id}")
                autotls_multiaddrs.append(f"/dns6/{host}/tcp/{ws_port}/tls/ws/p2p/{peer_id}")

    proxy_hostname = env_values.get("PROXY_HOSTNAME", "").strip()
    if proxy_hostname:
        proxy_multiaddrs.append(f"/dns4/{proxy_hostname}/tcp/443/tls/ws/p2p/{peer_id}")
        proxy_multiaddrs.append(f"/dns6/{proxy_hostname}/tcp/443/tls/ws/p2p/{peer_id}")

    public_ipv4 = env_values.get("PUBLIC_IPV4", "").strip()
    public_ipv6 = env_values.get("PUBLIC_IPV6", "").strip()
    udp_port = env_values.get("EXTERNAL_RELAY_UDP_PORT", "").strip()
    if udp_port:
        webtransport_multiaddrs.extend(
            public_udp_multiaddrs(
                public_ipv4,
                public_ipv6,
                udp_port,
                browser_transport_suffixes(listening_addrs, "quic-v1/webtransport"),
                peer_id,
            )
        )
        webrtc_direct_multiaddrs.extend(
            public_udp_multiaddrs(
                public_ipv4,
                public_ipv6,
                udp_port,
                browser_transport_suffixes(listening_addrs, "webrtc-direct"),
                peer_id,
            )
        )

    probe_multiaddrs.extend(direct_tcp_multiaddrs)
    probe_multiaddrs.extend(autotls_multiaddrs)
    probe_multiaddrs.extend(proxy_multiaddrs)

    return {
        "direct_tcp_multiaddrs": dedupe(direct_tcp_multiaddrs),
        "autotls_wss_multiaddrs": dedupe(autotls_multiaddrs),
        "proxy_wss_multiaddrs": dedupe(proxy_multiaddrs),
        "webtransport_multiaddrs": dedupe(webtransport_multiaddrs),
        "webrtc_direct_multiaddrs": dedupe(webrtc_direct_multiaddrs),
        "browser_bootstrap_multiaddrs": dedupe(
            autotls_multiaddrs + proxy_multiaddrs + webtransport_multiaddrs + webrtc_direct_multiaddrs
        ),
        "probe_multiaddrs": dedupe(probe_multiaddrs),
    }


def main() -> None:
    started_at = time.monotonic()
    deadline = time.monotonic() + WAIT_TIMEOUT_SECONDS
    peer_id = None
    listening_addrs: list[str] = []
    grouped = {
        "direct_tcp_multiaddrs": [],
        "autotls_wss_multiaddrs": [],
        "proxy_wss_multiaddrs": [],
        "webtransport_multiaddrs": [],
        "webrtc_direct_multiaddrs": [],
        "browser_bootstrap_multiaddrs": [],
        "probe_multiaddrs": [],
    }

    while time.monotonic() < deadline:
        env_values = parse_env_file(ENV_FILE)
        peer_id, listening_addrs = parse_logs()
        if not peer_id:
            time.sleep(WAIT_INTERVAL_SECONDS)
            continue

        grouped = build_probe_multiaddrs(env_values, peer_id, listening_addrs)
        proxy_hostname = env_values.get("PROXY_HOSTNAME", "").strip()
        if grouped["autotls_wss_multiaddrs"]:
            break
        if proxy_hostname and grouped["proxy_wss_multiaddrs"] and time.monotonic() - started_at >= AUTOTLS_EXTRA_WAIT_SECONDS:
            break
        if not proxy_hostname and time.monotonic() - started_at >= AUTOTLS_EXTRA_WAIT_SECONDS:
            break
        time.sleep(WAIT_INTERVAL_SECONDS)

    if not peer_id:
        raise SystemExit("unable to discover relay peer ID from service logs")

    env_values = parse_env_file(ENV_FILE)
    payload = {
        "peer_id": peer_id,
        "announce_addrs": [
            entry.strip()
            for entry in env_values.get("LIBP2P_ANNOUNCE_ADDRS", "").split(",")
            if entry.strip()
        ],
        "listening_addrs": listening_addrs,
        **grouped,
    }
    print(json.dumps(payload))


if __name__ == "__main__":
    main()
