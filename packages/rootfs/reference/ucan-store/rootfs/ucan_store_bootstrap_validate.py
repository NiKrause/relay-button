#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
from hashlib import sha256
from urllib.parse import urlsplit


ETH_ADDRESS_RE = re.compile(r"^0x[a-fA-F0-9]{40}$")


def _non_empty_string(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    return normalized or None


def _did(value: object) -> str | None:
    normalized = _non_empty_string(value)
    if normalized and normalized.startswith("did:"):
        return normalized
    return None


def _origin(value: object) -> str | None:
    normalized = _non_empty_string(value)
    if not normalized:
        return None
    try:
        parsed = urlsplit(normalized)
    except ValueError:
        return None

    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return None
    if parsed.path not in ("", "/") or parsed.query or parsed.fragment:
        return None
    return f"{parsed.scheme}://{parsed.netloc}"


def load_bootstrap_package(path: str) -> object | None:
    if not path or not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def summarize_bootstrap_package(
    path: str,
    *,
    runtime_service_did: str | None = None,
    runtime_service_origin: str | None = None,
    admin_did: str | None = None,
    allow_missing: bool = False,
) -> dict[str, object]:
    if not path or not os.path.exists(path):
        if allow_missing:
            return {
                "status": "missing",
                "valid": False,
                "errors": [],
                "warnings": ["Bootstrap package is not configured yet."],
                "package": None,
            }
        raise FileNotFoundError(path or "bootstrap package path missing")

    payload = load_bootstrap_package(path)
    if not isinstance(payload, dict):
        return {
            "status": "invalid",
            "valid": False,
            "errors": ["Bootstrap package must be a JSON object."],
            "warnings": [],
            "package": None,
        }

    errors: list[str] = []
    warnings: list[str] = []

    operator_address = _non_empty_string(payload.get("operatorAddress"))
    if not operator_address or not ETH_ADDRESS_RE.match(operator_address):
        errors.append(
            "operatorAddress must be a 0x-prefixed 20-byte Ethereum address.",
        )

    package_admin_did = _did(payload.get("adminDid"))
    if not package_admin_did:
        errors.append("adminDid must be a non-empty DID string.")

    service_did_raw = payload.get("serviceDid")
    service_did = None
    if service_did_raw not in (None, ""):
        service_did = _did(service_did_raw)
        if not service_did:
            errors.append("serviceDid must be empty or a non-empty DID string.")

    space_did = _did(payload.get("spaceDid"))
    if not space_did:
        errors.append("spaceDid must be a non-empty DID string.")

    root_delegation_proof = _non_empty_string(payload.get("rootDelegationProof"))
    if not root_delegation_proof:
        errors.append("rootDelegationProof must be a non-empty proof string.")

    allowed_capabilities_raw = payload.get("allowedCapabilities")
    allowed_capabilities = []
    if isinstance(allowed_capabilities_raw, list):
        allowed_capabilities = [
            capability
            for capability in (_non_empty_string(entry) for entry in allowed_capabilities_raw)
            if capability
        ]
    if not allowed_capabilities:
        errors.append("allowedCapabilities must contain at least one capability string.")

    default_expiration = payload.get("defaultUserDelegationExpiration")
    if default_expiration is not None and (
        not isinstance(default_expiration, int) or default_expiration < 0
    ):
        errors.append(
            "defaultUserDelegationExpiration must be null or a non-negative integer number of seconds.",
        )

    max_expiration = payload.get("maxUserDelegationExpiration")
    if max_expiration is not None and (
        not isinstance(max_expiration, int) or max_expiration < 0
    ):
        errors.append(
            "maxUserDelegationExpiration must be null or a non-negative integer number of seconds.",
        )
    if (
        isinstance(default_expiration, int)
        and isinstance(max_expiration, int)
        and default_expiration > max_expiration
    ):
        errors.append(
            "defaultUserDelegationExpiration cannot exceed maxUserDelegationExpiration.",
        )

    pwa_origin = _origin(payload.get("pwaOrigin"))
    if not pwa_origin:
        errors.append("pwaOrigin must be an http(s) origin without path, query, or hash.")

    service_origin = _origin(payload.get("serviceOrigin"))
    if not service_origin:
        errors.append("serviceOrigin must be an http(s) origin without path, query, or hash.")

    if admin_did and package_admin_did and admin_did != package_admin_did:
        errors.append("Configured admin DID does not match bootstrap package adminDid.")

    normalized_runtime_origin = _origin(runtime_service_origin) if runtime_service_origin else None
    service_did_matches_runtime = None
    if runtime_service_did and service_did:
        service_did_matches_runtime = runtime_service_did == service_did
        if not service_did_matches_runtime:
            errors.append("Bootstrap package serviceDid does not match the running service DID.")

    service_origin_matches_runtime = None
    if normalized_runtime_origin and service_origin:
        service_origin_matches_runtime = normalized_runtime_origin == service_origin
        if not service_origin_matches_runtime:
            errors.append(
                "Bootstrap package serviceOrigin does not match the configured public upload-service origin.",
            )

    summary = {
        "status": "valid" if not errors else "invalid",
        "valid": len(errors) == 0,
        "errors": errors,
        "warnings": warnings,
        "package": {
            "operatorAddress": operator_address,
            "adminDid": package_admin_did,
            "serviceDid": service_did,
            "spaceDid": space_did,
            "rootDelegationProofPresent": bool(root_delegation_proof),
            "rootDelegationProofSha256": sha256(
                (root_delegation_proof or "").encode("utf-8"),
            ).hexdigest()
            if root_delegation_proof
            else None,
            "allowedCapabilities": allowed_capabilities,
            "defaultUserDelegationExpiration": default_expiration
            if isinstance(default_expiration, int)
            else None,
            "maxUserDelegationExpiration": max_expiration
            if isinstance(max_expiration, int)
            else None,
            "pwaOrigin": pwa_origin,
            "serviceOrigin": service_origin,
        },
        "runtimeChecks": {
            "serviceDidMatchesRuntime": service_did_matches_runtime,
            "serviceOriginMatchesRuntime": service_origin_matches_runtime,
        },
    }
    return summary


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--package-file", required=True)
    parser.add_argument("--runtime-service-did", default="")
    parser.add_argument("--runtime-service-origin", default="")
    parser.add_argument("--admin-did", default="")
    parser.add_argument("--allow-missing", action="store_true")
    args = parser.parse_args()

    summary = summarize_bootstrap_package(
        args.package_file,
        runtime_service_did=_non_empty_string(args.runtime_service_did),
        runtime_service_origin=_non_empty_string(args.runtime_service_origin),
        admin_did=_non_empty_string(args.admin_did),
        allow_missing=args.allow_missing,
    )
    print(json.dumps(summary))
    if summary.get("status") == "invalid":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
