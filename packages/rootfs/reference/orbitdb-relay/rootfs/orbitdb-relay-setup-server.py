#!/usr/bin/env python3
import base64
import hashlib
import ipaddress
import json
import os
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen


ENV_FILE = os.environ.get("ENV_FILE", "/etc/default/orbitdb-relay")
READY_FILE = os.environ.get("READY_FILE", "/etc/default/orbitdb-relay.ready")
SERVICE_NAME = os.environ.get("SERVICE_NAME", "orbitdb-relay.service")
BOOTSTRAP_SERVICE = os.environ.get("BOOTSTRAP_SERVICE", "orbitdb-relay-bootstrap.service")
CONFIGURE_SCRIPT = "/usr/local/sbin/orbitdb-relay-configure.sh"
DESCRIBE_SCRIPT = "/usr/local/sbin/orbitdb-relay-describe.py"
METADATA_FILE = os.environ.get("METADATA_FILE", "/run/orbitdb-relay-setup-metadata.json")
METADATA_ERROR_FILE = os.environ.get("METADATA_ERROR_FILE", "/run/orbitdb-relay-setup-metadata.error")

# Guest-side bootstrap config handoff.
#
# A browser served over HTTPS cannot POST to this server: it listens on plain
# HTTP (it has to exist before Caddy/TLS does), so the request is blocked as
# mixed content. Instead the deployer publishes the configuration into a
# public Aleph aggregate and puts a locator into the VM's SSH key; the guest
# reads that locator, fetches its own configuration over HTTPS, applies it,
# and publishes a signed acknowledgement the deployer waits for.
AUTHORIZED_KEYS_FILE = os.environ.get("AUTHORIZED_KEYS_FILE", "/root/.ssh/authorized_keys")
ALEPH_API_HOST = os.environ.get("ALEPH_API_HOST", "https://api.aleph.im")
BOOTSTRAP_CONFIG_KEY = os.environ.get("BOOTSTRAP_CONFIG_KEY", "vm-bootstrap-config")
BOOTSTRAP_CONFIG_POLL_SECONDS = float(os.environ.get("BOOTSTRAP_CONFIG_POLL_SECONDS", "5"))
BOOTSTRAP_CONFIG_SIGNAL_REF = os.environ.get("BOOTSTRAP_CONFIG_SIGNAL_REF", "vm-bootstrap-config")
BOOTSTRAP_CONFIG_SIGNAL_POST_TYPE = os.environ.get(
    "BOOTSTRAP_CONFIG_SIGNAL_POST_TYPE", "vm-bootstrap-config-signal"
)
BOOTSTRAP_CHANNEL = os.environ.get("ALEPH_BOOTSTRAP_CHANNEL", "simple-todo")

CONFIGURE_LOCK = threading.Lock()


def _cors_headers(handler: BaseHTTPRequestHandler) -> None:
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    handler.send_header("Access-Control-Allow-Headers", "content-type")


def _validate_port(value: object, field_name: str) -> str:
    if not isinstance(value, int) or value < 1 or value > 65535:
        raise ValueError(f"{field_name} must be an integer TCP/UDP port between 1 and 65535")
    return str(value)


def _validate_proxy_hostname(value: object) -> str | None:
    if value is None:
        return None

    if not isinstance(value, str):
        raise ValueError("proxy_url must be a string when provided")

    candidate = value.strip()
    if not candidate:
        return None

    parsed = urlsplit(candidate if "://" in candidate else f"https://{candidate}")
    if not parsed.hostname:
        raise ValueError("proxy_url must include a valid hostname")

    return parsed.hostname


def _json_dumps(payload: object) -> str:
    return json.dumps(payload, separators=(",", ":"))


def _parse_env_file(path: str) -> dict[str, str]:
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


def _extract_guest_bootstrap_locator() -> tuple[str | None, str | None]:
    """Read the deployment locator the deployer left in our SSH key.

    The Aleph INSTANCE message carries an SSH public key with an extra
    `aleph-bootstrap-config:<owner>:<token>` part, so it lands in the guest's
    authorized_keys and gives us everything needed to find our own record.
    """
    try:
        with open(AUTHORIZED_KEYS_FILE, encoding="utf-8") as handle:
            for raw_line in handle:
                line = raw_line.strip()
                if not line or line.startswith("#"):
                    continue
                for part in line.split():
                    if part.startswith("aleph-bootstrap-config:"):
                        _, owner_address, deployment_token = part.split(":", 2)
                        owner_address = owner_address.strip()
                        deployment_token = deployment_token.strip()
                        if owner_address and deployment_token:
                            return owner_address, deployment_token
    except (FileNotFoundError, ValueError):
        return None, None

    return None, None


def _address_from_private_key(private_key: str) -> str:
    from eth_account import Account

    return Account.from_key(private_key).address


def _sign_personal_message(private_key: str, payload: str) -> str:
    from eth_account import Account
    from eth_account.messages import encode_defunct

    signed = Account.sign_message(encode_defunct(text=payload), private_key=private_key)
    signature = signed.signature.hex()
    return signature if signature.startswith("0x") else f"0x{signature}"


def _signature_payload(chain: str, sender: str, message_type: str, item_hash: str) -> str:
    return "\n".join([chain, sender, message_type, item_hash])


def _broadcast_aleph_message(api_host: str, message: dict[str, object]) -> None:
    body = json.dumps({"message": message, "sync": True}).encode("utf-8")
    request = Request(
        f"{api_host.rstrip('/')}/api/v0/messages",
        data=body,
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urlopen(request, timeout=30) as response:
        response.read()


def _fresh_metadata_payload() -> tuple[dict | None, str | None]:
    if os.path.exists(METADATA_FILE):
        try:
            with open(METADATA_FILE, encoding="utf-8") as handle:
                return json.load(handle), None
        except (OSError, json.JSONDecodeError) as error:
            return None, str(error)
    if os.path.exists(METADATA_ERROR_FILE):
        with open(METADATA_ERROR_FILE, encoding="utf-8") as handle:
            return None, handle.read().strip() or "metadata generation failed"
    return None, None


def _build_configure_args_from_record(record: dict) -> list[str]:
    """Map an Aleph bootstrap config record onto configure.sh arguments.

    Deliberately mirrors the /configure payload mapping, minus every secret:
    the record lives in a *public* aggregate, so it may only carry network
    facts, the registration id, the owner address and a signed authorization.
    """
    runtime = record.get("runtime") if isinstance(record.get("runtime"), dict) else {}
    bootstrap = record.get("bootstrap") if isinstance(record.get("bootstrap"), dict) else {}

    public_ipv4 = str(runtime.get("publicIpv4") or "").strip()
    if not public_ipv4:
        raise ValueError("bootstrap config is missing runtime.publicIpv4")

    mapped = runtime.get("mappedPorts") if isinstance(runtime.get("mappedPorts"), dict) else {}

    def host_port(*container_ports: str) -> int | None:
        for container_port in container_ports:
            entry = mapped.get(container_port)
            if isinstance(entry, dict):
                host = entry.get("host")
                if isinstance(host, int) and host > 0:
                    return host
        return None

    tcp_port = host_port("9091")
    ws_port = host_port("9092", "443")
    if not tcp_port or not ws_port:
        raise ValueError("bootstrap config is missing the mapped TCP/WS ports")

    args = [
        CONFIGURE_SCRIPT,
        "--public-ipv4",
        public_ipv4,
        "--tcp-port",
        str(tcp_port),
        "--ws-port",
        str(ws_port),
    ]

    public_ipv6 = str(runtime.get("publicIpv6") or "").strip()
    if public_ipv6:
        args.extend(["--public-ipv6", public_ipv6])

    proxy_hostname = _validate_proxy_hostname(runtime.get("proxyUrl"))
    if proxy_hostname:
        args.extend(["--proxy-hostname", proxy_hostname])

    for flag, container_ports in (
        ("--metrics-port", ("9090",)),
        ("--metrics-https-port", ("443",)),
        ("--webrtc-port", ("9093",)),
        ("--quic-port", ("9094",)),
    ):
        value = host_port(*container_ports)
        if value:
            args.extend([flag, str(value)])

    registration_id = str(bootstrap.get("registrationId") or "").strip()
    if registration_id:
        args.extend(["--bootstrap-registration-id", registration_id])

    owner_address = str(record.get("ownerAddress") or "").strip()
    if owner_address:
        args.extend(["--bootstrap-owner-address", owner_address])

    owner_authorization = str(bootstrap.get("ownerAuthorizationBase64") or "").strip()
    if owner_authorization:
        args.extend(["--bootstrap-owner-authorization-b64", owner_authorization])

    return args


def _run_configure_process(args: list[str], bootstrap_record: dict | None = None) -> tuple[bool, str]:
    with CONFIGURE_LOCK:
        if os.path.exists(READY_FILE):
            return True, "ready"
        try:
            result = subprocess.run(args, check=True, capture_output=True, text=True)
        except subprocess.CalledProcessError as error:
            return False, error.stderr.strip() or error.stdout.strip() or str(error)

        _clear_metadata_state()
        _generate_metadata_files()

        if isinstance(bootstrap_record, dict):
            try:
                _publish_vm_bootstrap_config_signal(bootstrap_record)
            except Exception as error:  # pragma: no cover - runtime error path
                return False, f"configured relay but failed to publish bootstrap signal: {error}"
        return True, result.stdout.strip()


def _publish_vm_bootstrap_config_signal(record: dict) -> None:
    """Tell the deployer we applied the config; it blocks until this appears."""
    env_values = _parse_env_file(ENV_FILE)
    publisher_private_key = env_values.get("ALEPH_BOOTSTRAP_PUBLISHER_PRIVATE_KEY", "").strip()
    if not publisher_private_key:
        raise RuntimeError("missing ALEPH_BOOTSTRAP_PUBLISHER_PRIVATE_KEY")

    owner_authorization = None
    owner_authorization_b64 = env_values.get("ALEPH_BOOTSTRAP_OWNER_AUTHORIZATION_B64", "").strip()
    if owner_authorization_b64:
        try:
            parsed = json.loads(base64.b64decode(owner_authorization_b64).decode("utf-8"))
            if isinstance(parsed, dict):
                owner_authorization = parsed
        except (ValueError, json.JSONDecodeError):
            owner_authorization = None

    owner_address = str(record.get("ownerAddress") or "").strip()
    deployment_token = str(record.get("deploymentToken") or "").strip()
    profile = str(record.get("profile") or "").strip()
    instance_item_hash = str(record.get("instanceItemHash") or "").strip()
    if not deployment_token or not profile or not instance_item_hash:
        raise RuntimeError("bootstrap config signal is missing deployment metadata")

    metadata, metadata_error = _fresh_metadata_payload()
    if not metadata:
        raise RuntimeError(
            f"bootstrap config signal metadata is not ready: {metadata_error or 'unavailable'}"
        )

    peer_id = metadata.get("peer_id")
    probe_multiaddrs = metadata.get("probe_multiaddrs")
    browser_bootstrap_multiaddrs = metadata.get("browser_bootstrap_multiaddrs")
    if not isinstance(peer_id, str) or not peer_id.strip():
        raise RuntimeError("bootstrap config signal is missing peer_id")
    if not isinstance(probe_multiaddrs, list) or not any(
        isinstance(entry, str) and entry.strip() for entry in probe_multiaddrs
    ):
        raise RuntimeError("bootstrap config signal is missing probe_multiaddrs")
    if not isinstance(browser_bootstrap_multiaddrs, list):
        browser_bootstrap_multiaddrs = []

    publisher_address = _address_from_private_key(publisher_private_key)
    now_ms = int(time.time() * 1000)
    content = {
        "type": BOOTSTRAP_CONFIG_SIGNAL_POST_TYPE,
        "address": publisher_address,
        "ref": BOOTSTRAP_CONFIG_SIGNAL_REF,
        "content": {
            "deploymentToken": deployment_token,
            "status": "applied",
            "profile": profile,
            "ownerAddress": owner_address,
            "instanceItemHash": instance_item_hash,
            "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now_ms / 1000)),
            "publisherAddress": publisher_address,
            "authorization": owner_authorization,
            "peerId": peer_id.strip(),
            "probeMultiaddrs": [
                entry.strip()
                for entry in probe_multiaddrs
                if isinstance(entry, str) and entry.strip()
            ],
            "browserBootstrapMultiaddrs": [
                entry.strip()
                for entry in browser_bootstrap_multiaddrs
                if isinstance(entry, str) and entry.strip()
            ],
        },
        "time": now_ms,
    }
    item_content = _json_dumps(content)
    message = {
        "channel": BOOTSTRAP_CHANNEL,
        "sender": publisher_address,
        "chain": "ETH",
        "type": "POST",
        "time": now_ms / 1000,
        "item_type": "inline",
        "item_content": item_content,
        "item_hash": hashlib.sha256(item_content.encode("utf-8")).hexdigest(),
    }
    message["signature"] = _sign_personal_message(
        publisher_private_key,
        _signature_payload(
            str(message["chain"]),
            str(message["sender"]),
            str(message["type"]),
            str(message["item_hash"]),
        ),
    )
    _broadcast_aleph_message(ALEPH_API_HOST, message)


def _load_vm_bootstrap_record() -> tuple[str | None, str | None, dict | None]:
    owner_address, deployment_token = _extract_guest_bootstrap_locator()
    if not owner_address or not deployment_token:
        return owner_address, deployment_token, None

    request_url = (
        f"{ALEPH_API_HOST.rstrip('/')}/api/v0/aggregates/{owner_address}.json?"
        f"{urlencode({'keys': BOOTSTRAP_CONFIG_KEY})}"
    )

    try:
        with urlopen(request_url, timeout=10) as response:
            payload = json.loads(response.read().decode("utf-8") or "{}")
    except (HTTPError, URLError, json.JSONDecodeError, TimeoutError):
        return owner_address, deployment_token, None

    aggregate = payload.get("data", {}).get(BOOTSTRAP_CONFIG_KEY, {})
    if not isinstance(aggregate, dict):
        return owner_address, deployment_token, None

    record = aggregate.get(deployment_token)
    return owner_address, deployment_token, record if isinstance(record, dict) else None


def _poll_bootstrap_config_loop() -> None:
    while not os.path.exists(READY_FILE):
        _, deployment_token, record = _load_vm_bootstrap_record()
        if deployment_token and isinstance(record, dict):
            status = str(record.get("status") or "").strip().lower()
            if status == "pending":
                try:
                    args = _build_configure_args_from_record(record)
                except ValueError:
                    time.sleep(BOOTSTRAP_CONFIG_POLL_SECONDS)
                    continue
                ok, _ = _run_configure_process(args, record)
                if ok:
                    return
        time.sleep(BOOTSTRAP_CONFIG_POLL_SECONDS)


class Handler(BaseHTTPRequestHandler):
    server_version = "OrbitdbRelaySetup/1.0"

    def _request_path(self) -> str:
        return urlsplit(self.path).path

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        _cors_headers(self)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args) -> None:  # noqa: A003
        return

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        _cors_headers(self)
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        if self._request_path() == "/metadata":
            self._handle_metadata()
            return

        if self._request_path() not in ("/", "/health"):
            self._send_json(404, {"status": "not-found"})
            return

        self._send_json(
            200,
            {
                "status": "waiting-for-port-mapping",
                "ready": os.path.exists(READY_FILE),
                "env_file": ENV_FILE,
                "metadata_ready": os.path.exists(METADATA_FILE),
            },
        )

    def _handle_metadata(self) -> None:
        if os.path.exists(METADATA_FILE):
            with open(METADATA_FILE, encoding="utf-8") as handle:
                metadata = json.load(handle)
            self._send_json(200, {"status": "ready", "metadata": metadata})
            threading.Thread(target=self.server.shutdown, daemon=True).start()  # type: ignore[arg-type]
            threading.Thread(target=_stop_bootstrap_service, daemon=True).start()
            return

        if os.path.exists(METADATA_ERROR_FILE):
            with open(METADATA_ERROR_FILE, encoding="utf-8") as handle:
                error_message = handle.read().strip() or "metadata generation failed"
            self._send_json(500, {"status": "error", "error": error_message})
            threading.Thread(target=self.server.shutdown, daemon=True).start()  # type: ignore[arg-type]
            threading.Thread(target=_stop_bootstrap_service, daemon=True).start()
            return

        self._send_json(202, {"status": "pending"})

    def do_POST(self) -> None:  # noqa: N802
        if self._request_path() != "/configure":
            self._send_json(404, {"status": "not-found"})
            return

        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send_json(400, {"status": "bad-request", "error": "Invalid Content-Length"})
            return

        try:
            payload = json.loads(self.rfile.read(content_length).decode("utf-8") or "{}")
        except json.JSONDecodeError as error:
            self._send_json(400, {"status": "bad-request", "error": f"Invalid JSON body: {error}"})
            return

        try:
            public_ipv4 = str(ipaddress.ip_address(payload.get("public_ipv4")))
            public_ipv6 = payload.get("public_ipv6")
            if public_ipv6 is not None:
                public_ipv6 = str(ipaddress.ip_address(public_ipv6))
            tcp_port = _validate_port(payload.get("tcp_port"), "tcp_port")
            ws_port = _validate_port(payload.get("ws_port"), "ws_port")
            proxy_hostname = _validate_proxy_hostname(payload.get("proxy_url"))
            metrics_port = payload.get("metrics_port")
            metrics_https_port = payload.get("metrics_https_port")
            webrtc_port = payload.get("webrtc_port")
            quic_port = payload.get("quic_port")
            bootstrap_publisher_private_key = payload.get("bootstrap_publisher_private_key")
            bootstrap_publisher_libp2p_identity_hex = payload.get(
                "bootstrap_publisher_libp2p_identity_hex"
            )
            # NOTE: `bootstrap_owner_private_key` is deliberately NOT accepted
            # here. This endpoint is plain HTTP (it runs before Caddy/TLS
            # exists), so anything sent to it crosses the network in the
            # clear. The owner only ever needs to hand the guest a *signed
            # authorization*, never the key itself.
            bootstrap_owner_authorization_b64 = payload.get("bootstrap_owner_authorization_b64")
            bootstrap_registration_id = payload.get("bootstrap_registration_id")
            no_start = bool(payload.get("no_start"))
            args = [
                CONFIGURE_SCRIPT,
                "--public-ipv4",
                public_ipv4,
                "--tcp-port",
                tcp_port,
                "--ws-port",
                ws_port,
            ]
            if proxy_hostname is not None:
                args.extend(["--proxy-hostname", proxy_hostname])
            if public_ipv6 is not None:
                args.extend(["--public-ipv6", public_ipv6])
            if metrics_port is not None:
                args.extend(["--metrics-port", _validate_port(metrics_port, "metrics_port")])
            if metrics_https_port is not None:
                args.extend(
                    [
                        "--metrics-https-port",
                        _validate_port(metrics_https_port, "metrics_https_port"),
                    ]
                )
            if webrtc_port is not None:
                args.extend(["--webrtc-port", _validate_port(webrtc_port, "webrtc_port")])
            if quic_port is not None:
                args.extend(["--quic-port", _validate_port(quic_port, "quic_port")])
            if bootstrap_publisher_private_key is not None:
                args.extend(["--bootstrap-publisher-private-key", str(bootstrap_publisher_private_key)])
            if bootstrap_publisher_libp2p_identity_hex is not None:
                args.extend(
                    [
                        "--bootstrap-publisher-libp2p-identity-hex",
                        str(bootstrap_publisher_libp2p_identity_hex),
                    ]
                )
            if bootstrap_owner_authorization_b64 is not None:
                args.extend(
                    ["--bootstrap-owner-authorization-b64", str(bootstrap_owner_authorization_b64)]
                )
            if bootstrap_registration_id is not None:
                args.extend(["--bootstrap-registration-id", str(bootstrap_registration_id)])
            if no_start:
                args.append("--no-start")
        except ValueError as error:
            self._send_json(400, {"status": "bad-request", "error": str(error)})
            return

        try:
            result = subprocess.run(
                args,
                check=True,
                capture_output=True,
                text=True,
            )
        except subprocess.CalledProcessError as error:
            self._send_json(
                500,
                {
                    "status": "error",
                    "error": error.stderr.strip() or error.stdout.strip() or str(error),
                },
            )
            return

        _clear_metadata_state()
        threading.Thread(target=_generate_metadata_files, daemon=True).start()

        self._send_json(
            200,
            {
                "status": "configured",
                "stdout": result.stdout.strip(),
                "metadata_pending": True,
            },
        )


def _stop_bootstrap_service() -> None:
    time.sleep(1)
    subprocess.run(["systemctl", "stop", BOOTSTRAP_SERVICE], check=False)


def _clear_metadata_state() -> None:
    for path in (METADATA_FILE, METADATA_ERROR_FILE):
        try:
            os.remove(path)
        except FileNotFoundError:
            pass


def _generate_metadata_files() -> None:
    try:
        describe = subprocess.run(
            [DESCRIBE_SCRIPT],
            check=True,
            capture_output=True,
            text=True,
        )
        payload = json.loads(describe.stdout.strip() or "{}")
        with open(METADATA_FILE, "w", encoding="utf-8") as handle:
            json.dump(payload, handle)
    except (subprocess.CalledProcessError, json.JSONDecodeError) as error:
        with open(METADATA_ERROR_FILE, "w", encoding="utf-8") as handle:
            handle.write(str(error))


def main() -> None:
    # Poll for our own Aleph bootstrap config alongside the HTTP listener, so
    # a deployer that cannot reach this plain-HTTP endpoint (any page served
    # over HTTPS) can hand the configuration over through Aleph instead. The
    # first path to succeed wins; the other becomes a no-op once READY_FILE
    # exists and CONFIGURE_LOCK serialises them.
    threading.Thread(target=_poll_bootstrap_config_loop, daemon=True).start()

    server = ThreadingHTTPServer(("0.0.0.0", 80), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
