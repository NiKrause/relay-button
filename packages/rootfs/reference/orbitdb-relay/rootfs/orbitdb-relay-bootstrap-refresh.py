#!/usr/bin/env python3
import base64
import hashlib
import ipaddress
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

try:
    from eth_account import Account
    from eth_account.messages import encode_defunct
except ImportError as error:  # pragma: no cover - runtime dependency
    raise SystemExit(
        "eth-account is required for guest-side bootstrap refresh publishing"
    ) from error


ENV_FILE = os.environ.get("ENV_FILE", "/etc/default/orbitdb-relay")
DESCRIBE_SCRIPT = os.environ.get(
    "DESCRIBE_SCRIPT", "/usr/local/sbin/orbitdb-relay-describe.py"
)
DEFAULT_API_HOST = os.environ.get("ALEPH_BOOTSTRAP_API_HOST", "https://api.aleph.im")
DEFAULT_CHANNEL = os.environ.get("ALEPH_BOOTSTRAP_CHANNEL", "simple-todo")
DEFAULT_REF = os.environ.get("ALEPH_BOOTSTRAP_REF", "simple-todo-bootstrap")
COMPACT_POST_TYPE = "relay-bootstrap-v2"
LEGACY_POST_TYPE = "relay-bootstrap"
DEFAULT_POST_TYPE = os.environ.get("ALEPH_BOOTSTRAP_POST_TYPE", COMPACT_POST_TYPE)
DEFAULT_PROFILE = os.environ.get("ALEPH_BOOTSTRAP_PROFILE", "orbitdb-relay")
MAX_PREVIOUS_PAGES = int(os.environ.get("ALEPH_BOOTSTRAP_MAX_PREVIOUS_PAGES", "5"))
PAGINATION = int(os.environ.get("ALEPH_BOOTSTRAP_PAGINATION", "50"))
COMPACT_MULTIADDR_LIMIT = int(os.environ.get("ALEPH_BOOTSTRAP_COMPACT_MULTIADDR_LIMIT", "3"))
STALE_RECORD_MAX_AGE_SECONDS = int(
    os.environ.get("ALEPH_BOOTSTRAP_STALE_RECORD_MAX_AGE_SECONDS", str(6 * 60 * 60))
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


def dedupe(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        if value and value not in seen:
            seen.add(value)
            result.append(value)
    return result


def split_multiaddr(addr: str) -> list[str]:
    return [part for part in addr.split("/") if part]


def has_peer_id(addr: str) -> bool:
    return "p2p" in split_multiaddr(addr)


def is_browser_dialable(addr: str) -> bool:
    normalized = addr.lower()
    return any(
        token in normalized
        for token in ("/ws", "/wss", "/webtransport", "/webrtc-direct")
    )


def is_public_multiaddr(addr: str) -> bool:
    parts = split_multiaddr(addr)
    if not parts:
        return False

    try:
        for index, token in enumerate(parts[:-1]):
            value = parts[index + 1]
            if token == "ip4" and ipaddress.ip_address(value).is_private:
                return False
            if token == "ip6":
                ip = ipaddress.ip_address(value)
                if ip.is_loopback or ip.is_private or ip.is_link_local:
                    return False
            if token in ("dns", "dns4", "dns6"):
                host = value.strip().lower()
                if host == "localhost" or host.endswith(".localhost") or host.endswith(".local"):
                    return False
    except ValueError:
        return False

    return has_peer_id(addr)


def filter_public_multiaddrs(values: list[str], browser_only: bool = False) -> list[str]:
    filtered: list[str] = []
    for value in values:
        if not isinstance(value, str):
            continue
        candidate = value.strip()
        if not candidate or not is_public_multiaddr(candidate):
            continue
        if browser_only and not is_browser_dialable(candidate):
            continue
        filtered.append(candidate)
    return dedupe(filtered)


def browser_multiaddr_preference(addr: str) -> int:
    normalized = addr.lower()
    if "/tcp/443/tls/ws/" in normalized:
        return 0
    if "/tls/ws/" in normalized:
        return 1
    if "/webtransport/" in normalized:
        return 2
    if "/webrtc-direct/" in normalized:
        return 3
    if "/ws" in normalized:
        return 4
    return 5


def select_compact_multiaddrs(values: list[str]) -> list[str]:
    public_browser_addrs = filter_public_multiaddrs(values, browser_only=True)
    return sorted(public_browser_addrs, key=browser_multiaddr_preference)[
        : max(1, COMPACT_MULTIADDR_LIMIT)
    ]


def json_dumps(payload: object) -> str:
    return json.dumps(payload, separators=(",", ":"))


def sign_personal_message(private_key: str, payload: str) -> str:
    message = encode_defunct(text=payload)
    signed = Account.sign_message(message, private_key=private_key)
    return signed.signature.hex()


def address_from_private_key(private_key: str) -> str:
    return Account.from_key(private_key).address


def signature_payload(chain: str, sender: str, message_type: str, item_hash: str) -> str:
    return "\n".join([chain, sender, message_type, item_hash])


def relay_authorization_payload(
    owner_address: str,
    publisher_address: str,
    peer_id: str,
    registration_id: str | None,
    profile: str | None,
    version: str | None,
    issued_at: int,
) -> dict[str, object]:
    return {
        "ownerAddress": owner_address,
        "publisherAddress": publisher_address,
        "peerId": peer_id,
        "registrationId": registration_id,
        "profile": profile,
        "version": version,
        "instanceItemHash": None,
        "issuedAt": issued_at,
        "expiresAt": None,
    }


def relay_proof_payload(
    peer_id: str,
    multiaddrs: list[str],
    browser_multiaddrs: list[str],
    registration_id: str | None,
    profile: str | None,
    version: str | None,
    updated_at: int,
) -> dict[str, object]:
    payload: dict[str, object] = {
        "peerId": peer_id,
        "multiaddrs": dedupe(multiaddrs),
        "registrationId": registration_id,
        "profile": profile,
        "version": version,
        "updatedAt": updated_at,
    }
    if browser_multiaddrs:
        payload["browserMultiaddrs"] = dedupe(browser_multiaddrs)
    return payload


def load_owner_authorization(
    env_values: dict[str, str],
    publisher_address: str,
    peer_id: str,
    registration_id: str | None,
    profile: str | None,
    version: str | None,
    issued_at: int,
) -> dict[str, object] | None:
    encoded = env_values.get("ALEPH_BOOTSTRAP_OWNER_AUTHORIZATION_B64", "").strip()
    if encoded:
        decoded = base64.b64decode(encoded).decode("utf-8")
        payload = json.loads(decoded)
        if isinstance(payload, dict):
            return payload

    owner_private_key = env_values.get("ALEPH_BOOTSTRAP_OWNER_PRIVATE_KEY", "").strip()
    if not owner_private_key:
        return None

    owner_address = address_from_private_key(owner_private_key)
    payload = relay_authorization_payload(
        owner_address,
        publisher_address,
        peer_id,
        registration_id,
        profile,
        version,
        issued_at,
    )
    return {
        "scheme": "personal_sign",
        "payload": payload,
        "signature": sign_personal_message(owner_private_key, json_dumps(payload)),
    }


def post_json(url: str, body: dict[str, object]) -> tuple[int, dict]:
    data = json_dumps(body).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = response.read().decode("utf-8")
            return response.status, json.loads(payload or "{}")
    except urllib.error.HTTPError as error:
        payload = error.read().decode("utf-8")
        try:
            return error.code, json.loads(payload or "{}")
        except json.JSONDecodeError:
            return error.code, {"details": payload}


def get_json(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=30) as response:
        return json.loads(response.read().decode("utf-8") or "{}")


def build_post_content(
    sender: str,
    peer_id: str,
    multiaddrs: list[str],
    browser_multiaddrs: list[str],
    registration_id: str | None,
    profile: str | None,
    version: str | None,
    owner_authorization: dict[str, object] | None,
    relay_proof: dict[str, object],
    now_ms: int,
    ref: str,
    post_type: str,
) -> dict[str, object]:
    content = {
        "peerId": peer_id,
        "multiaddrs": multiaddrs,
        "browserMultiaddrs": browser_multiaddrs if browser_multiaddrs else None,
        "registrationId": registration_id,
        "profile": profile,
        "version": version,
        "ownerAddress": (
            owner_authorization.get("payload", {}).get("ownerAddress")
            if isinstance(owner_authorization, dict)
            else None
        ),
        "publisherAddress": sender,
        "authorization": owner_authorization,
        "relayProof": relay_proof,
        "updatedAt": now_ms,
    }
    return {
        "type": post_type,
        "address": sender,
        "ref": ref,
        "content": content,
        "time": now_ms,
    }


def build_unsigned_message(sender: str, item_content: str, now_seconds: float, channel: str) -> dict[str, object]:
    item_hash = hashlib.sha256(item_content.encode("utf-8")).hexdigest()
    return {
        "channel": channel,
        "sender": sender,
        "chain": "ETH",
        "type": "POST",
        "time": now_seconds,
        "item_type": "inline",
        "item_content": item_content,
        "item_hash": item_hash,
    }


def sign_aleph_message(unsigned_message: dict[str, object], private_key: str) -> dict[str, object]:
    signed = dict(unsigned_message)
    signed["signature"] = sign_personal_message(
        private_key,
        signature_payload(
            str(unsigned_message["chain"]),
            str(unsigned_message["sender"]),
            str(unsigned_message["type"]),
            str(unsigned_message["item_hash"]),
        ),
    )
    return signed


def broadcast_aleph_message(api_host: str, message: dict[str, object]) -> tuple[int, dict]:
    url = urllib.parse.urljoin(api_host.rstrip("/") + "/", "api/v0/messages")
    request_body = {"sync": True, "message": message}
    max_attempts = 3
    last: tuple[int, dict] | None = None
    for index in range(max_attempts):
        last = post_json(url, request_body)
        if 200 <= last[0] < 300:
            return last
        publication_status = last[1].get("publication_status") if isinstance(last[1], dict) else None
        retryable = last[0] >= 500 or (
            isinstance(publication_status, dict)
            and isinstance(publication_status.get("status"), str)
            and publication_status.get("status").strip().lower() == "error"
        )
        if index >= max_attempts - 1 or not retryable:
            raise RuntimeError(f"Aleph broadcast failed: {last[0]} {json_dumps(last[1])}")
    raise RuntimeError("Aleph broadcast failed: retry budget exhausted")


def parse_post_record(entry: object) -> dict[str, object] | None:
    if not isinstance(entry, dict):
        return None
    item_hash = entry.get("item_hash") or entry.get("hash")
    if not isinstance(item_hash, str) or not item_hash:
        return None

    sender = entry.get("address") or entry.get("sender")
    item_content = entry.get("item_content")
    if isinstance(item_content, str):
        try:
            item_content = json.loads(item_content)
        except json.JSONDecodeError:
            item_content = None

    content_source = item_content if isinstance(item_content, dict) else entry
    content = content_source.get("content")
    if not isinstance(content, dict):
        return None

    return {
        "item_hash": item_hash,
        "sender": sender,
        "publisher_address": content.get("publisherAddress"),
        "registration_id": content.get("registrationId"),
        "peer_id": content.get("peerId"),
        "profile": content.get("profile"),
        "updated_at": content.get("updatedAt"),
    }


def normalize_address(value: object) -> str:
    return str(value or "").strip().lower()


def timestamp_ms(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, str):
        stripped = value.strip()
        if stripped.isdigit():
            return int(stripped)
    return None


def fetch_previous_hashes(
    api_host: str,
    channel: str,
    ref: str,
    post_types: list[str],
    sender: str,
    current_item_hash: str,
    now_ms: int,
) -> list[str]:
    stale_cutoff_ms = now_ms - (STALE_RECORD_MAX_AGE_SECONDS * 1000)
    normalized_sender = normalize_address(sender)
    found: list[str] = []
    for post_type in post_types:
        for page in range(1, MAX_PREVIOUS_PAGES + 1):
            url = (
                f"{api_host.rstrip('/')}/api/v0/posts.json?"
                f"channels={urllib.parse.quote(channel)}&"
                f"refs={urllib.parse.quote(ref)}&"
                f"types={urllib.parse.quote(post_type)}&"
                f"pagination={PAGINATION}&page={page}"
            )
            payload = get_json(url)
            posts = payload.get("posts")
            if not isinstance(posts, list):
                break

            for entry in posts:
                parsed = parse_post_record(entry)
                if parsed is None:
                    continue
                same_publisher = normalized_sender in {
                    normalize_address(parsed["sender"]),
                    normalize_address(parsed["publisher_address"]),
                }
                if not same_publisher:
                    continue
                if parsed["item_hash"] == current_item_hash:
                    continue
                updated_at = timestamp_ms(parsed["updated_at"])
                if updated_at is not None and updated_at < stale_cutoff_ms:
                    found.append(str(parsed["item_hash"]))

            if len(posts) < PAGINATION:
                break

    return dedupe(found)


def broadcast_forget(
    api_host: str,
    sender: str,
    private_key: str,
    hashes: list[str],
    channel: str,
) -> tuple[int, dict] | None:
    if not hashes:
        return None

    now_seconds = time.time()
    item_content = json_dumps(
        {
            "address": sender,
            "time": now_seconds,
            "hashes": hashes,
            "aggregates": [],
            "reason": f"Replace older relay bootstrap records for {sender}",
        }
    )
    unsigned = {
        "sender": sender,
        "chain": "ETH",
        "type": "FORGET",
        "item_hash": hashlib.sha256(item_content.encode("utf-8")).hexdigest(),
        "item_type": "inline",
        "item_content": item_content,
        "time": now_seconds,
        "channel": channel,
    }
    return broadcast_aleph_message(api_host, sign_aleph_message(unsigned, private_key))


def main() -> None:
    env_values = parse_env_file(ENV_FILE)
    publisher_private_key = env_values.get("ALEPH_BOOTSTRAP_PUBLISHER_PRIVATE_KEY", "").strip()
    registration_id = env_values.get("ALEPH_BOOTSTRAP_REGISTRATION_ID", "").strip() or None
    if not publisher_private_key:
        print(json_dumps({"status": "skipped", "reason": "missing publisher key"}))
        return

    describe = subprocess.run([DESCRIBE_SCRIPT], check=True, capture_output=True, text=True)
    metadata = json.loads(describe.stdout.strip() or "{}")
    peer_id = metadata.get("peer_id")
    if not isinstance(peer_id, str) or not peer_id.strip():
        raise SystemExit("unable to discover relay peer ID from describe script")

    multiaddrs = filter_public_multiaddrs(metadata.get("probe_multiaddrs") or [])
    browser_multiaddrs = filter_public_multiaddrs(
        metadata.get("browser_bootstrap_multiaddrs") or [], browser_only=True
    )

    publisher_address = address_from_private_key(publisher_private_key)
    now_ms = int(time.time() * 1000)
    now_seconds = now_ms / 1000
    profile = env_values.get("ALEPH_BOOTSTRAP_PROFILE", DEFAULT_PROFILE).strip() or DEFAULT_PROFILE
    version = env_values.get("ALEPH_BOOTSTRAP_VERSION", "").strip() or None
    channel = env_values.get("ALEPH_BOOTSTRAP_CHANNEL", DEFAULT_CHANNEL).strip() or DEFAULT_CHANNEL
    ref = env_values.get("ALEPH_BOOTSTRAP_REF", DEFAULT_REF).strip() or DEFAULT_REF
    post_type = env_values.get("ALEPH_BOOTSTRAP_POST_TYPE", DEFAULT_POST_TYPE).strip() or DEFAULT_POST_TYPE
    api_host = env_values.get("ALEPH_BOOTSTRAP_API_HOST", DEFAULT_API_HOST).strip() or DEFAULT_API_HOST
    compact = post_type == COMPACT_POST_TYPE
    published_multiaddrs = (
        select_compact_multiaddrs(browser_multiaddrs or multiaddrs)
        if compact
        else multiaddrs
    )
    published_browser_multiaddrs = [] if compact else browser_multiaddrs
    if not published_multiaddrs:
        reason = "no public browser multiaddrs" if compact else "no public multiaddrs"
        print(json_dumps({"status": "skipped", "reason": reason}))
        return

    owner_authorization = load_owner_authorization(
        env_values,
        publisher_address,
        peer_id,
        registration_id,
        profile,
        version,
        now_ms,
    )
    if owner_authorization is None:
        print(json_dumps({"status": "skipped", "reason": "missing owner authorization"}))
        return

    proof_payload = relay_proof_payload(
        peer_id,
        published_multiaddrs,
        published_browser_multiaddrs,
        registration_id,
        profile,
        version,
        now_ms,
    )
    relay_proof = {
        "scheme": "personal_sign",
        "payload": proof_payload,
        "signature": sign_personal_message(publisher_private_key, json_dumps(proof_payload)),
    }
    post_content = build_post_content(
        publisher_address,
        peer_id,
        published_multiaddrs,
        published_browser_multiaddrs,
        registration_id,
        profile,
        version,
        owner_authorization,
        relay_proof,
        now_ms,
        ref,
        post_type,
    )
    item_content = json_dumps(post_content)
    unsigned_message = build_unsigned_message(
        publisher_address, item_content, now_seconds, channel
    )
    signed_message = sign_aleph_message(unsigned_message, publisher_private_key)
    http_status, response = broadcast_aleph_message(api_host, signed_message)

    previous_hashes = fetch_previous_hashes(
        api_host,
        channel,
        ref,
        [post_type, LEGACY_POST_TYPE] if compact else [post_type],
        publisher_address,
        str(unsigned_message["item_hash"]),
        now_ms,
    )
    forget_response = broadcast_forget(
        api_host, publisher_address, publisher_private_key, previous_hashes, channel
    )

    print(
        json_dumps(
            {
                "status": "published",
                "httpStatus": http_status,
                "itemHash": unsigned_message["item_hash"],
                "sender": publisher_address,
                "peerId": peer_id,
                "publishedMultiaddrs": published_multiaddrs,
                "publishedBrowserMultiaddrs": published_browser_multiaddrs or published_multiaddrs,
                "forgottenHashes": previous_hashes,
                "forgetStaleOlderThanSeconds": STALE_RECORD_MAX_AGE_SECONDS,
                "forgetResponse": forget_response[1] if forget_response else None,
                "response": response,
            }
        )
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # pragma: no cover - runtime error path
        print(json_dumps({"status": "error", "error": str(error)}), file=sys.stderr)
        raise
