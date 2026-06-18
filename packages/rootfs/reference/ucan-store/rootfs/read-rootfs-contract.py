#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import shlex
import sys
from pathlib import Path


def shell_assign(name: str, value: str) -> str:
    return f"{name}={shlex.quote(value)}"


def main() -> int:
    parser = argparse.ArgumentParser(description="Read a ucan-store rootfs contract and emit shell exports.")
    parser.add_argument("contract", type=Path, help="Path to the rootfs contract JSON file")
    args = parser.parse_args()

    try:
        payload = json.loads(args.contract.read_text())
    except FileNotFoundError:
        print(f"Missing rootfs contract: {args.contract}", file=sys.stderr)
        return 1
    except json.JSONDecodeError as exc:
        print(f"Invalid rootfs contract JSON in {args.contract}: {exc}", file=sys.stderr)
        return 1

    rootfs = payload.get("rootfs") or {}
    services = payload.get("services") or {}
    source = payload.get("source") or {}
    manifest = payload.get("manifest") or {}
    ports = payload.get("ports") or []

    profile = rootfs.get("profile")
    install_mode = rootfs.get("installMode")

    if not isinstance(profile, str) or not profile.strip():
        print("Rootfs contract is missing rootfs.profile", file=sys.stderr)
        return 1
    if not isinstance(install_mode, str) or not install_mode.strip():
        print("Rootfs contract is missing rootfs.installMode", file=sys.stderr)
        return 1
    if not isinstance(ports, list):
        print("Rootfs contract field ports must be a list", file=sys.stderr)
        return 1

    lines = [
        shell_assign("ROOTFS_CONTRACT_PATH", str(args.contract.resolve())),
        shell_assign("ROOTFS_CONTRACT_ID", str(payload.get("id", ""))),
        shell_assign("ROOTFS_CONTRACT_PROFILE", profile.strip()),
        shell_assign("ROOTFS_CONTRACT_INSTALL_MODE", install_mode.strip()),
        shell_assign("ROOTFS_CONTRACT_SOURCE_SUBDIRECTORY", str(source.get("subdirectory", ""))),
        shell_assign("ROOTFS_CONTRACT_INSTALL_DIR", str(rootfs.get("installDir", ""))),
        shell_assign("ROOTFS_CONTRACT_BINARY_PATH", str(rootfs.get("binaryPath", "/usr/local/bin/ucan-store"))),
        shell_assign("ROOTFS_CONTRACT_DATA_DIR", str(rootfs.get("dataDir", ""))),
        shell_assign("ROOTFS_CONTRACT_ENV_FILE", str(rootfs.get("envFile", ""))),
        shell_assign("ROOTFS_CONTRACT_MAIN_SERVICE", str(services.get("main", ""))),
        shell_assign("ROOTFS_CONTRACT_BOOTSTRAP_SERVICE", str(services.get("bootstrap", ""))),
        shell_assign("ROOTFS_CONTRACT_AUTOTLS_SERVICE", str(services.get("autotlsRefresh", ""))),
        shell_assign("ROOTFS_CONTRACT_MANIFEST_COPY_TARGET", str(manifest.get("copyTarget", ""))),
        shell_assign("ROOTFS_CONTRACT_MANIFEST_NOTES", str(manifest.get("notes", ""))),
        shell_assign("ROOTFS_CONTRACT_PORT_FORWARDS_JSON", json.dumps(ports, separators=(",", ":"))),
    ]

    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
