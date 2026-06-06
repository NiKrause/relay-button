#!/usr/bin/env python3
import ipaddress
import json
import os
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import urlopen


ENV_FILE = os.environ.get("ENV_FILE", "/etc/default/uc-go-peer")
READY_FILE = os.environ.get("READY_FILE", "/etc/default/uc-go-peer.ready")
CONFIGURE_SCRIPT = "/usr/local/sbin/uc-go-peer-configure.sh"
DESCRIBE_SCRIPT = "/usr/local/sbin/uc-go-peer-describe.py"
BOOTSTRAP_SERVICE = os.environ.get("BOOTSTRAP_SERVICE", "uc-go-peer-bootstrap.service")
METADATA_FILE = os.environ.get("METADATA_FILE", "/run/uc-go-peer-setup-metadata.json")
METADATA_ERROR_FILE = os.environ.get("METADATA_ERROR_FILE", "/run/uc-go-peer-setup-metadata.error")
AUTHORIZED_KEYS_FILE = os.environ.get("AUTHORIZED_KEYS_FILE", "/root/.ssh/authorized_keys")
ALEPH_API_HOST = os.environ.get("ALEPH_API_HOST", "https://api2.aleph.im")
BOOTSTRAP_CONFIG_KEY = os.environ.get("BOOTSTRAP_CONFIG_KEY", "vm-bootstrap-config")
BOOTSTRAP_CONFIG_POLL_SECONDS = float(os.environ.get("BOOTSTRAP_CONFIG_POLL_SECONDS", "5"))
DESCRIBE_TIMEOUT_SECONDS = int(os.environ.get("DESCRIBE_TIMEOUT_SECONDS", "15"))
DESCRIBE_INTERVAL_SECONDS = float(os.environ.get("DESCRIBE_INTERVAL_SECONDS", "1"))

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


def _extract_guest_bootstrap_locator() -> tuple[str | None, str | None]:
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


def _clear_metadata_state() -> None:
    for path in (METADATA_FILE, METADATA_ERROR_FILE):
        try:
            os.remove(path)
        except FileNotFoundError:
            pass


def _start_metadata_generation() -> None:
    _clear_metadata_state()
    threading.Thread(target=_generate_metadata_files, daemon=True).start()


def _service_active(service_name: str) -> bool:
    result = subprocess.run(
        ["systemctl", "is-active", service_name],
        check=False,
        capture_output=True,
        text=True,
    )
    return result.returncode == 0 and result.stdout.strip() == "active"


def _build_configure_args(record: dict) -> list[str]:
    runtime = record.get("runtime") if isinstance(record.get("runtime"), dict) else {}
    bootstrap = record.get("bootstrap") if isinstance(record.get("bootstrap"), dict) else {}
    public_ipv4 = str(runtime.get("publicIpv4") or "").strip()
    if not public_ipv4:
        raise ValueError("bootstrap config missing runtime.publicIpv4")

    mapped_ports = runtime.get("mappedPorts") if isinstance(runtime.get("mappedPorts"), dict) else {}
    relay_tcp = mapped_ports.get("9095") if isinstance(mapped_ports.get("9095"), dict) else {}
    relay_ws = mapped_ports.get("9097") if isinstance(mapped_ports.get("9097"), dict) else {}
    relay_udp = mapped_ports.get("9095") if isinstance(mapped_ports.get("9095"), dict) else {}

    args = [CONFIGURE_SCRIPT, "--public-ipv4", public_ipv4]

    public_ipv6 = str(runtime.get("publicIpv6") or "").strip()
    if public_ipv6:
        args.extend(["--public-ipv6", public_ipv6])

    proxy_hostname = _validate_proxy_hostname(runtime.get("proxyUrl"))
    if proxy_hostname:
        args.extend(["--proxy-hostname", proxy_hostname])

    relay_tcp_host = relay_tcp.get("host")
    relay_ws_host = relay_ws.get("host")
    relay_udp_host = relay_udp.get("host") if relay_udp.get("udp") is True else None

    if isinstance(relay_tcp_host, int) and relay_tcp_host > 0:
        args.extend(["--tcp-port", str(relay_tcp_host)])
    if isinstance(relay_ws_host, int) and relay_ws_host > 0:
        args.extend(["--ws-port", str(relay_ws_host)])
    if isinstance(relay_udp_host, int) and relay_udp_host > 0:
        args.extend(["--udp-port", str(relay_udp_host)])

    registration_id = str(bootstrap.get("registrationId") or "").strip()
    if registration_id:
        args.extend(["--bootstrap-registration-id", registration_id])
    owner_auth = str(bootstrap.get("ownerAuthorizationBase64") or "").strip()
    if owner_auth:
        args.extend(["--bootstrap-owner-authorization-b64", owner_auth])

    return args


def _run_configure_process(args: list[str]) -> tuple[bool, str]:
    with CONFIGURE_LOCK:
        if os.path.exists(READY_FILE):
            return True, "ready"
        try:
            result = subprocess.run(args, check=True, capture_output=True, text=True)
        except subprocess.CalledProcessError as error:
            return False, error.stderr.strip() or error.stdout.strip() or str(error)

        _start_metadata_generation()
        return True, result.stdout.strip()


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
    except HTTPError as error:
        if error.code == 404:
            return owner_address, deployment_token, None
        return owner_address, deployment_token, None
    except (URLError, json.JSONDecodeError, TimeoutError):
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
            if status != "pending":
                time.sleep(BOOTSTRAP_CONFIG_POLL_SECONDS)
                continue
            try:
                args = _build_configure_args(record)
            except ValueError:
                time.sleep(BOOTSTRAP_CONFIG_POLL_SECONDS)
                continue
            ok, _ = _run_configure_process(args)
            if ok:
                return
        time.sleep(BOOTSTRAP_CONFIG_POLL_SECONDS)


class Handler(BaseHTTPRequestHandler):
    server_version = "UcGoPeerSetup/1.0"

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

        self._send_json(200, _health_payload())

    def _handle_metadata(self) -> None:
        status, payload = _metadata_status_payload()
        self._send_json(status, payload)

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
            proxy_hostname = _validate_proxy_hostname(payload.get("proxy_url"))
            tcp_port = payload.get("tcp_port")
            ws_port = payload.get("ws_port")
            udp_port = payload.get("udp_port")
            quic_port = payload.get("quic_port")
            webrtc_port = payload.get("webrtc_port")
            bootstrap_publisher_private_key = payload.get("bootstrap_publisher_private_key")
            bootstrap_publisher_libp2p_identity_b64 = payload.get(
                "bootstrap_publisher_libp2p_identity_b64"
            )
            bootstrap_owner_private_key = payload.get("bootstrap_owner_private_key")
            bootstrap_owner_authorization_b64 = payload.get("bootstrap_owner_authorization_b64")
            bootstrap_registration_id = payload.get("bootstrap_registration_id")
            no_start = bool(payload.get("no_start"))
            args = [
                CONFIGURE_SCRIPT,
                "--public-ipv4",
                public_ipv4,
            ]
            if tcp_port is not None:
                args.extend(["--tcp-port", _validate_port(tcp_port, "tcp_port")])
            if ws_port is not None:
                args.extend(["--ws-port", _validate_port(ws_port, "ws_port")])
            if proxy_hostname is not None:
                args.extend(["--proxy-hostname", proxy_hostname])
            if public_ipv6 is not None:
                args.extend(["--public-ipv6", public_ipv6])
            udp_candidate = udp_port if udp_port is not None else quic_port
            if udp_candidate is None:
                udp_candidate = webrtc_port
            if udp_candidate is not None:
                args.extend(["--udp-port", _validate_port(udp_candidate, "udp_port")])
            if bootstrap_publisher_private_key is not None:
                args.extend(["--bootstrap-publisher-private-key", str(bootstrap_publisher_private_key)])
            if bootstrap_publisher_libp2p_identity_b64 is not None:
                args.extend(
                    [
                        "--bootstrap-publisher-libp2p-identity-b64",
                        str(bootstrap_publisher_libp2p_identity_b64),
                    ]
                )
            if bootstrap_owner_private_key is not None:
                args.extend(["--bootstrap-owner-private-key", str(bootstrap_owner_private_key)])
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

        ok, output = _run_configure_process(args)
        if not ok:
            self._send_json(
                500,
                {
                    "status": "error",
                    "error": output or "configure failed",
                },
            )
            return

        self._send_json(
            200,
            {
                "status": "configured",
                "stdout": output,
                "metadata_pending": True,
            },
        )


def _describe_metadata() -> dict:
    try:
        describe = subprocess.run(
            [DESCRIBE_SCRIPT],
            check=True,
            capture_output=True,
            text=True,
            env={
                **os.environ,
                "DESCRIBE_WAIT_TIMEOUT_SECONDS": str(DESCRIBE_TIMEOUT_SECONDS),
                "DESCRIBE_WAIT_INTERVAL_SECONDS": str(DESCRIBE_INTERVAL_SECONDS),
            },
        )
        return json.loads(describe.stdout.strip() or "{}")
    except (subprocess.CalledProcessError, json.JSONDecodeError) as error:
        raise RuntimeError(str(error)) from error


def _write_metadata_files(payload: dict) -> None:
    Path(METADATA_FILE).write_text(json.dumps(payload), encoding="utf-8")
    try:
        os.remove(METADATA_ERROR_FILE)
    except FileNotFoundError:
        pass


def _write_metadata_error(error_message: str) -> None:
    try:
        os.remove(METADATA_FILE)
    except FileNotFoundError:
        pass
    Path(METADATA_ERROR_FILE).write_text(error_message, encoding="utf-8")


def _generate_metadata_files() -> None:
    try:
        payload = _describe_metadata()
        _write_metadata_files(payload)
    except RuntimeError as error:
        _write_metadata_error(str(error))


def _fresh_metadata_payload() -> tuple[dict | None, str | None]:
    try:
        payload = _describe_metadata()
        _write_metadata_files(payload)
        return payload, None
    except RuntimeError as error:
        return None, str(error)


def _read_cached_metadata() -> dict | None:
    try:
        with open(METADATA_FILE, encoding="utf-8") as handle:
            payload = json.load(handle)
    except (FileNotFoundError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def _read_cached_metadata_error() -> str | None:
    try:
        message = Path(METADATA_ERROR_FILE).read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return None
    return message or "metadata generation failed"


def _metadata_status_payload() -> tuple[int, dict]:
    if not os.path.exists(READY_FILE):
        return 202, {"status": "pending"}

    payload, error_message = _fresh_metadata_payload()
    if payload is not None:
        return 200, {"status": "ready", "metadata": payload}

    cached_payload = _read_cached_metadata()
    if cached_payload is not None:
        return 200, {"status": "ready", "metadata": cached_payload, "stale": True}

    cached_error = error_message or _read_cached_metadata_error()
    if _service_active("uc-go-peer.service"):
        return 202, {
            "status": "pending",
            "ready": True,
            "relay_active": True,
            "error": cached_error,
        }

    return 500, {"status": "error", "error": cached_error or "metadata generation failed"}


def _health_payload() -> dict:
    relay_ready = os.path.exists(READY_FILE)
    metadata_status, metadata_payload = _metadata_status_payload()
    return {
        "status": "ready" if relay_ready and metadata_status == 200 else "waiting-for-port-mapping",
        "ready": relay_ready,
        "env_file": ENV_FILE,
        "metadata_ready": metadata_status == 200,
        "relay_active": _service_active("uc-go-peer.service"),
        "caddy_active": _service_active("caddy.service"),
        "bootstrap_active": _service_active(BOOTSTRAP_SERVICE),
        "metadata_status": metadata_payload.get("status"),
    }


def main() -> None:
    threading.Thread(target=_poll_bootstrap_config_loop, daemon=True).start()
    server = ThreadingHTTPServer(("0.0.0.0", 80), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
