#!/usr/bin/env python3
import ipaddress
import json
import os
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit


ENV_FILE = os.environ.get("ENV_FILE", "/etc/default/orbitdb-relay")
READY_FILE = os.environ.get("READY_FILE", "/etc/default/orbitdb-relay.ready")
SERVICE_NAME = os.environ.get("SERVICE_NAME", "orbitdb-relay.service")
BOOTSTRAP_SERVICE = os.environ.get("BOOTSTRAP_SERVICE", "orbitdb-relay-bootstrap.service")
CONFIGURE_SCRIPT = "/usr/local/sbin/orbitdb-relay-configure.sh"
DESCRIBE_SCRIPT = "/usr/local/sbin/orbitdb-relay-describe.py"
METADATA_FILE = os.environ.get("METADATA_FILE", "/run/orbitdb-relay-setup-metadata.json")
METADATA_ERROR_FILE = os.environ.get("METADATA_ERROR_FILE", "/run/orbitdb-relay-setup-metadata.error")


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
            bootstrap_owner_private_key = payload.get("bootstrap_owner_private_key")
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
    server = ThreadingHTTPServer(("0.0.0.0", 80), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
