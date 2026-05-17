#!/usr/bin/env python3
import json
import sys
from pathlib import Path

import requests
from cid import make_cid


def upload_directory(folder: Path, gateway: str) -> dict[str, str]:
    url = f"{gateway.rstrip('/')}/api/v0/add"
    params = {
        "recursive": "true",
        "wrap-with-directory": "true",
    }

    handles = []
    files = []
    try:
        for path in sorted(folder.rglob("*")):
            if not path.is_file():
                continue
            relative_path = path.relative_to(folder)
            handle = path.open("rb")
            handles.append(handle)
            files.append(("file", (str(relative_path), handle)))

        if not files:
            raise RuntimeError(f"No files found under {folder}")

        response = requests.post(url, params=params, files=files, timeout=300)
        response.raise_for_status()

        cid_v0 = None
        for line in response.text.strip().splitlines():
            entry = json.loads(line)
            cid_v0 = entry.get("Hash") or cid_v0

        if not cid_v0:
            raise RuntimeError("CID not found in IPFS response")

        cid_v1 = make_cid(cid_v0).to_v1().encode("base32").decode()
        return {"cid_v0": cid_v0, "cid_v1": cid_v1}
    finally:
        for handle in handles:
            handle.close()


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: publish-static-site.py <directory>", file=sys.stderr)
        return 2

    directory = Path(sys.argv[1]).resolve()
    if not directory.is_dir():
        print(f"Error: path must be a directory: {directory}", file=sys.stderr)
        return 1

    result = upload_directory(directory, "https://ipfs-2.aleph.im")
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
