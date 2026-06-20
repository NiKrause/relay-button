#!/usr/bin/env python3
import json
import os
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit


ENV_FILE = os.environ.get("ENV_FILE", "/etc/default/ucan-store")
READY_FILE = os.environ.get("READY_FILE", "/etc/default/ucan-store.ready")
SERVICE_NAME = os.environ.get("SERVICE_NAME", "ucan-store.service")
BOOTSTRAP_SERVICE = os.environ.get("BOOTSTRAP_SERVICE", "ucan-store-bootstrap.service")
CONFIGURE_SCRIPT = "/usr/local/sbin/ucan-store-configure.sh"
DESCRIBE_SCRIPT = "/usr/local/sbin/ucan-store-describe.py"
METADATA_FILE = os.environ.get("METADATA_FILE", "/run/ucan-store-setup-metadata.json")
METADATA_ERROR_FILE = os.environ.get("METADATA_ERROR_FILE", "/run/ucan-store-setup-metadata.error")


def _cors_headers(handler: BaseHTTPRequestHandler) -> None:
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    handler.send_header("Access-Control-Allow-Headers", "content-type")


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


def _stop_bootstrap_service() -> None:
    subprocess.run(["systemctl", "stop", BOOTSTRAP_SERVICE], check=False)


class Handler(BaseHTTPRequestHandler):
    server_version = "UcanStoreSetup/1.0"

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
                "status": "waiting-for-service-config",
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

        public_ipv4 = str(payload.get("public_ipv4") or "").strip()
        public_ipv6 = str(payload.get("public_ipv6") or "").strip()
        proxy_candidate = str(payload.get("proxy_url") or "").strip()
        parsed_proxy = urlsplit(
            proxy_candidate if "://" in proxy_candidate else f"https://{proxy_candidate}"
        ) if proxy_candidate else None
        proxy_hostname = parsed_proxy.hostname if parsed_proxy and parsed_proxy.hostname else proxy_candidate
        service_did = str(payload.get("service_did") or "").strip()
        service_origin = str(payload.get("service_origin") or "").strip()
        admin_did = str(payload.get("admin_did") or "").strip()
        admin_api_token = str(payload.get("admin_api_token") or "").strip()
        webauthn_origin = str(payload.get("webauthn_origin") or "").strip()
        webauthn_origin_fallbacks = str(payload.get("webauthn_origin_fallbacks") or "").strip()
        no_start = bool(payload.get("no_start"))
        bootstrap_package = payload.get("bootstrap_package")

        if not public_ipv4:
            self._send_json(400, {"status": "bad-request", "error": "public_ipv4 is required"})
            return
        if bootstrap_package not in (None, "") and not isinstance(bootstrap_package, dict):
            self._send_json(
                400,
                {"status": "bad-request", "error": "bootstrap_package must be a JSON object when provided"},
            )
            return

        args = [
            CONFIGURE_SCRIPT,
            "--public-ipv4",
            public_ipv4,
        ]
        bootstrap_package_file = None
        if public_ipv6:
            args.extend(["--public-ipv6", public_ipv6])
        if proxy_hostname:
            args.extend(["--proxy-hostname", proxy_hostname])
        if service_did:
            args.extend(["--service-did", service_did])
        if service_origin:
            args.extend(["--service-origin", service_origin])
        if admin_did:
            args.extend(["--admin-did", admin_did])
        if admin_api_token:
            args.extend(["--admin-api-token", admin_api_token])
        if webauthn_origin:
            args.extend(["--webauthn-origin", webauthn_origin])
        if webauthn_origin_fallbacks:
            args.extend(["--webauthn-origin-fallbacks", webauthn_origin_fallbacks])
        if isinstance(bootstrap_package, dict):
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                prefix="ucan-store-bootstrap-",
                suffix=".json",
                dir="/run",
                delete=False,
            ) as handle:
                json.dump(bootstrap_package, handle)
                bootstrap_package_file = handle.name
            args.extend(["--bootstrap-package-file", bootstrap_package_file])
        if no_start:
            args.append("--no-start")

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
        finally:
            if bootstrap_package_file:
                try:
                    os.remove(bootstrap_package_file)
                except FileNotFoundError:
                    pass

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


def main() -> None:
    server = ThreadingHTTPServer(("0.0.0.0", 80), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
