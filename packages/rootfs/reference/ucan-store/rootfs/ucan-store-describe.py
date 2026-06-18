#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request

from ucan_store_bootstrap_validate import summarize_bootstrap_package


ENV_FILE = os.environ.get("ENV_FILE", "/etc/default/ucan-store")
SERVICE_PORT = int(os.environ.get("STORACHA_LOCAL_PORT", "8787"))
WAIT_TIMEOUT_SECONDS = int(os.environ.get("DESCRIBE_WAIT_TIMEOUT_SECONDS", "120"))
WAIT_INTERVAL_SECONDS = float(os.environ.get("DESCRIBE_WAIT_INTERVAL_SECONDS", "2"))
BOOTSTRAP_PACKAGE_FILE = os.environ.get(
    "BOOTSTRAP_PACKAGE_FILE",
    "/etc/ucan-store/bootstrap-package.json",
)
BOOTSTRAP_VERIFICATION_FILE = os.environ.get(
    "BOOTSTRAP_VERIFICATION_FILE",
    "/etc/ucan-store/bootstrap-verification.json",
)


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


def fetch_service_did(port: int) -> str:
    url = f"http://127.0.0.1:{port}/.well-known/did.json"
    deadline = time.monotonic() + WAIT_TIMEOUT_SECONDS
    last_error = None

    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=5) as response:
                payload = json.loads(response.read().decode("utf-8"))
            did = payload.get("id")
            if isinstance(did, str) and did.strip():
                return did.strip()
            last_error = "did.json missing id"
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            last_error = str(error)
        time.sleep(WAIT_INTERVAL_SECONDS)

    raise SystemExit(last_error or "unable to discover upload service DID")


def read_json_file(path: str) -> dict[str, object] | None:
    if not path or not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as handle:
        payload = json.load(handle)
    return payload if isinstance(payload, dict) else None


def main() -> None:
    env_values = parse_env_file(ENV_FILE)
    service_did = env_values.get("PUBLIC_UPLOAD_SERVICE_DID", "").strip() or fetch_service_did(SERVICE_PORT)
    upload_url = env_values.get("PUBLIC_UPLOAD_SERVICE_URL", "").strip()
    revocation_url = env_values.get("PUBLIC_REVOCATION_URL", "").strip() or upload_url
    receipts_url = env_values.get("PUBLIC_RECEIPTS_URL", "").strip() or (upload_url.rstrip("/") + "/receipt/" if upload_url else "")
    bootstrap_package_file = (
        env_values.get("UCAN_STORE_BOOTSTRAP_PACKAGE_FILE", "").strip()
        or BOOTSTRAP_PACKAGE_FILE
    )
    bootstrap_verification_file = (
        env_values.get("UCAN_STORE_BOOTSTRAP_VERIFICATION_FILE", "").strip()
        or BOOTSTRAP_VERIFICATION_FILE
    )
    bootstrap_validation = summarize_bootstrap_package(
        bootstrap_package_file,
        runtime_service_did=service_did,
        runtime_service_origin=upload_url or None,
        admin_did=env_values.get("UCAN_STORE_ADMIN_DID", "").strip() or None,
        allow_missing=True,
    )
    bootstrap_proof_validation = read_json_file(bootstrap_verification_file)
    if bootstrap_validation.get("status") == "invalid":
        raise SystemExit(
            "bootstrap package validation failed: "
            + "; ".join(bootstrap_validation.get("errors", [])),
        )
    if bootstrap_proof_validation and bootstrap_proof_validation.get("status") == "invalid":
        raise SystemExit(
            "bootstrap proof verification failed: "
            + "; ".join(bootstrap_proof_validation.get("errors", [])),
        )

    payload = {
        "service_did": service_did,
        "service_identity": {
            "did": service_did,
            "configured_did": env_values.get("UCAN_STORE_SERVICE_DID", "").strip() or None,
            "key_algorithm": env_values.get(
                "UCAN_STORE_SERVICE_KEY_ALGORITHM",
                "",
            ).strip()
            or None,
        },
        "delegation_issuance": {
            "enabled": bool(env_values.get("UCAN_STORE_ADMIN_API_TOKEN", "").strip()),
            "policy_endpoint": f"{upload_url}/admin/delegations/policy" if upload_url else None,
            "issue_endpoint": f"{upload_url}/admin/delegations" if upload_url else None,
            "proof_format": "ucan-car-multibase-base64",
        },
        "service_manifest": {
            "endpoint": f"{upload_url}/.well-known/ucan-store.json" if upload_url else None,
            "alias": f"{upload_url}/service-manifest.json" if upload_url else None,
            "binding": "domain-first",
        },
        "upload_service_url": upload_url or None,
        "upload_service_did": service_did,
        "revocation_url": revocation_url or None,
        "revocation_did": env_values.get("PUBLIC_REVOCATION_DID", "").strip() or service_did,
        "receipts_url": receipts_url or None,
        "proxy_hostname": env_values.get("PROXY_HOSTNAME", "").strip() or None,
        "public_ipv4": env_values.get("PUBLIC_IPV4", "").strip() or None,
        "public_ipv6": env_values.get("PUBLIC_IPV6", "").strip() or None,
        "admin_did": env_values.get("UCAN_STORE_ADMIN_DID", "").strip() or None,
        "webauthn_origin": env_values.get("WEBAUTHN_ORIGIN", "").strip() or None,
        "webauthn_origin_fallbacks": env_values.get("WEBAUTHN_ORIGIN_FALLBACKS", "").strip() or None,
        "bootstrap_validation": bootstrap_validation,
        "bootstrap_proof_validation": bootstrap_proof_validation,
        "pwa_env": {
            "VITE_UPLOAD_SERVICE_URL": upload_url or None,
            "VITE_UPLOAD_SERVICE_DID": service_did,
            "VITE_REVOCATION_URL": revocation_url or None,
            "VITE_REVOCATION_DID": env_values.get("PUBLIC_REVOCATION_DID", "").strip() or service_did,
            "VITE_RECEIPTS_URL": receipts_url or None,
        },
    }
    print(json.dumps(payload))


if __name__ == "__main__":
    main()
