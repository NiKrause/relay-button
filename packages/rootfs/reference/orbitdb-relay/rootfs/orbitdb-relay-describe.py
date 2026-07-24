#!/usr/bin/env python3
import json
import os
import re
import socket
import ssl
import time
import urllib.error
import urllib.request


ENV_FILE = os.environ.get("ENV_FILE", "/etc/default/orbitdb-relay")
METRICS_PORT = int(os.environ.get("METRICS_PORT", "9090"))
CADDY_HTTPS_PORT = int(os.environ.get("CADDY_HTTPS_PORT", "443"))
# Internal libp2p WebSocket listener; AutoTLS terminates its *.libp2p.direct
# TLS on this same listener (SNI-detected), so a local handshake against it
# verifies the AutoTLS certificate the same way :443 verifies Caddy's.
RELAY_WS_PORT = int(os.environ.get("RELAY_WS_PORT", "9092"))
WAIT_TIMEOUT_SECONDS = int(os.environ.get("DESCRIBE_WAIT_TIMEOUT_SECONDS", "240"))
WAIT_INTERVAL_SECONDS = float(os.environ.get("DESCRIBE_WAIT_INTERVAL_SECONDS", "2"))
AUTOTLS_EXTRA_WAIT_SECONDS = int(os.environ.get("DESCRIBE_AUTOTLS_EXTRA_WAIT_SECONDS", "120"))


def tls_endpoint_serves(hostname: str, port: int) -> bool:
    """True only once the local listener on `port` serves a publicly-trusted
    TLS certificate for `hostname`.

    The recurring failure shape ("advertise before the certificate serves"):
    an address is announced as browser-dialable while its Let's Encrypt cert
    is still being acquired, so browsers dialing it fail the TLS handshake
    with net::ERR_SSL_PROTOCOL_ERROR. This bit twice — first for Caddy's 2n6
    proxy (cert acquired asynchronously after the caddy restart), then for
    libp2p AutoTLS (multiaddrs appear before the *.libp2p.direct cert is
    live). Verify the real browser-facing certificate with a TLS handshake to
    the local listener using the public hostname as SNI — done locally so
    hairpin-NAT to the VM's own public IP is irrelevant, and validated
    against the system CA store so any self-signed placeholder (Caddy's
    pre-ACME fallback) is rejected.
    """
    if not hostname:
        return False
    context = ssl.create_default_context()
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=8) as raw:
            with context.wrap_socket(raw, server_hostname=hostname) as tls:
                # A validated peer cert here means the handshake a browser
                # will perform against this hostname succeeds too.
                return bool(tls.getpeercert())
    except (ssl.SSLError, OSError, ValueError):
        return False


def caddy_cert_serves(hostname: str) -> bool:
    return tls_endpoint_serves(hostname, CADDY_HTTPS_PORT)


def autotls_cert_serves(autotls_addrs: list[str]) -> bool:
    """Verify the AutoTLS *.libp2p.direct certificate actually serves.

    The libp2p WebSocket listener terminates the AutoTLS certificate itself
    (SNI-detected on the same internal port that also speaks plain ws), so a
    CA-validated handshake to 127.0.0.1:<ws-port> with the libp2p.direct
    hostname as SNI proves what a browser's wss:// dial will experience.
    """
    for addr in autotls_addrs:
        match = re.search(r"/sni/([^/]+)/", addr) or re.search(r"/dns[46]/([^/]+)/", addr)
        if match:
            return tls_endpoint_serves(match.group(1), RELAY_WS_PORT)
    return False


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


def fetch_json(path: str) -> dict:
    url = f"http://127.0.0.1:{METRICS_PORT}{path}"
    with urllib.request.urlopen(url, timeout=5) as response:
        return json.loads(response.read().decode("utf-8"))


def dedupe(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        if value and value not in seen:
            seen.add(value)
            result.append(value)
    return result


def normalize_multiaddrs(payload: dict) -> list[str]:
    values = payload.get("all")
    if not isinstance(values, list):
        return []
    return [entry for entry in values if isinstance(entry, str) and entry.strip()]


def bootstrap_publisher_address(env_values: dict[str, str]) -> str | None:
    """Address of the key this relay signs its own Aleph registrations with.

    The guest generates that key itself, so the deployer cannot know the
    address up front. Reporting it here lets the deployer bind an owner
    authorization to the relay's real publisher identity instead of having to
    send the key to the guest over the plain-HTTP setup endpoint.
    """
    private_key = env_values.get("ALEPH_BOOTSTRAP_PUBLISHER_PRIVATE_KEY", "").strip()
    if not private_key:
        return None

    try:
        from eth_account import Account
    except ImportError:
        return None

    try:
        return Account.from_key(private_key).address
    except (ValueError, TypeError):
        return None


def build_grouped_multiaddrs(env_values: dict[str, str], all_multiaddrs: list[str], peer_id: str) -> dict[str, list[str]]:
    proxy_hostname = env_values.get("PROXY_HOSTNAME", "").strip().lower()
    direct_tcp_multiaddrs = [addr for addr in all_multiaddrs if "/tcp/" in addr and "/ws" not in addr]
    autotls_wss_multiaddrs = [
        addr
        for addr in all_multiaddrs
        if addr.endswith("/ws/p2p/" + peer_id) and "/tls/ws" in addr and proxy_hostname not in addr.lower()
    ]
    plain_ws_multiaddrs = [
        addr for addr in all_multiaddrs if addr.endswith("/ws/p2p/" + peer_id) and "/tls/ws" not in addr
    ]
    proxy_wss_multiaddrs: list[str] = []
    if proxy_hostname:
        proxy_wss_multiaddrs = [
            f"/dns4/{proxy_hostname}/tcp/443/tls/ws/p2p/{peer_id}",
            f"/dns6/{proxy_hostname}/tcp/443/tls/ws/p2p/{peer_id}",
        ]
    quic_multiaddrs = [addr for addr in all_multiaddrs if "/quic-v1" in addr and "/webtransport" not in addr]
    webtransport_multiaddrs = [addr for addr in all_multiaddrs if "/webtransport" in addr]
    webrtc_direct_multiaddrs = [addr for addr in all_multiaddrs if "/webrtc-direct" in addr]

    browser_bootstrap_multiaddrs = dedupe(
        proxy_wss_multiaddrs
        + autotls_wss_multiaddrs
        + plain_ws_multiaddrs
        + webtransport_multiaddrs
        + webrtc_direct_multiaddrs
    )
    probe_multiaddrs = dedupe(
        direct_tcp_multiaddrs
        + proxy_wss_multiaddrs
        + autotls_wss_multiaddrs
        + quic_multiaddrs
        + webtransport_multiaddrs
    )

    return {
        "direct_tcp_multiaddrs": dedupe(direct_tcp_multiaddrs),
        "autotls_wss_multiaddrs": dedupe(autotls_wss_multiaddrs),
        "proxy_wss_multiaddrs": dedupe(proxy_wss_multiaddrs),
        "plain_ws_multiaddrs": dedupe(plain_ws_multiaddrs),
        "quic_multiaddrs": dedupe(quic_multiaddrs),
        "webtransport_multiaddrs": dedupe(webtransport_multiaddrs),
        "webrtc_direct_multiaddrs": dedupe(webrtc_direct_multiaddrs),
        "browser_bootstrap_multiaddrs": browser_bootstrap_multiaddrs,
        "probe_multiaddrs": probe_multiaddrs,
    }


def main() -> None:
    started_at = time.monotonic()
    deadline = started_at + WAIT_TIMEOUT_SECONDS
    health: dict = {}
    multiaddrs_payload: dict = {}
    grouped = {
        "direct_tcp_multiaddrs": [],
        "autotls_wss_multiaddrs": [],
        "proxy_wss_multiaddrs": [],
        "plain_ws_multiaddrs": [],
        "quic_multiaddrs": [],
        "webtransport_multiaddrs": [],
        "webrtc_direct_multiaddrs": [],
        "browser_bootstrap_multiaddrs": [],
        "probe_multiaddrs": [],
    }

    while time.monotonic() < deadline:
        try:
            env_values = parse_env_file(ENV_FILE)
            health = fetch_json("/health")
            multiaddrs_payload = fetch_json("/multiaddrs")
            peer_id = health.get("peerId") or multiaddrs_payload.get("peerId")
            if not isinstance(peer_id, str) or not peer_id.strip():
                time.sleep(WAIT_INTERVAL_SECONDS)
                continue

            all_multiaddrs = normalize_multiaddrs(multiaddrs_payload)
            grouped = build_grouped_multiaddrs(env_values, all_multiaddrs, peer_id)
            proxy_hostname = env_values.get("PROXY_HOSTNAME", "").strip()

            # Symmetric certificate gate for BOTH browser paths. Whichever of
            # Caddy/2n6 and libp2p AutoTLS finishes its ACME first varies per
            # VM; breaking on the mere *presence* of AutoTLS multiaddrs made
            # the outcome a per-VM coin flip — a fast AutoTLS zone produced an
            # acknowledgement containing only libp2p.direct addresses whose
            # cert was not serving yet (ERR_SSL_PROTOCOL_ERROR in browsers),
            # while the verifiable 2n6 address never made it in. Only
            # cert-verified addresses are advertised, and the wait ends as
            # soon as at least one verified browser path exists.
            proxy_cert_ready = bool(
                proxy_hostname
                and grouped["proxy_wss_multiaddrs"]
                and caddy_cert_serves(proxy_hostname)
            )
            autotls_cert_ready = bool(
                grouped["autotls_wss_multiaddrs"]
                and autotls_cert_serves(grouped["autotls_wss_multiaddrs"])
            )

            unverified: set[str] = set()
            if grouped["proxy_wss_multiaddrs"] and not proxy_cert_ready:
                unverified.update(grouped["proxy_wss_multiaddrs"])
            if grouped["autotls_wss_multiaddrs"] and not autotls_cert_ready:
                unverified.update(grouped["autotls_wss_multiaddrs"])
            if unverified:
                grouped["browser_bootstrap_multiaddrs"] = [
                    addr
                    for addr in grouped["browser_bootstrap_multiaddrs"]
                    if addr not in unverified
                ]

            if proxy_cert_ready or autotls_cert_ready:
                break
            if not proxy_hostname and time.monotonic() - started_at >= AUTOTLS_EXTRA_WAIT_SECONDS:
                break
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
            pass

        time.sleep(WAIT_INTERVAL_SECONDS)

    peer_id = health.get("peerId") or multiaddrs_payload.get("peerId")
    if not isinstance(peer_id, str) or not peer_id.strip():
        raise SystemExit("unable to discover orbitdb relay peer ID from metrics endpoints")

    env_values = parse_env_file(ENV_FILE)
    payload = {
        "peer_id": peer_id,
        "bootstrap_publisher_address": bootstrap_publisher_address(env_values),
        "announce_addrs": [
            entry.strip()
            for entry in env_values.get("VITE_APPEND_ANNOUNCE", "").split(",")
            if entry.strip()
        ],
        "listening_addrs": normalize_multiaddrs(multiaddrs_payload),
        "auto_tls_serving_zone": health.get("autoTlsServingZone"),
        "metrics_https": health.get("metricsHttps"),
        **grouped,
    }
    print(json.dumps(payload))


if __name__ == "__main__":
    main()
