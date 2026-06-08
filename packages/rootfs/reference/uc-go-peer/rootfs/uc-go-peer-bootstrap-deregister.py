#!/usr/bin/env python3
import hashlib
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
        "eth-account is required for guest-side bootstrap deregistration"
    ) from error


ENV_FILE = os.environ.get("ENV_FILE", "/etc/default/uc-go-peer")
DESCRIBE_SCRIPT = os.environ.get("DESCRIBE_SCRIPT", "/usr/local/sbin/uc-go-peer-describe.py")
DEFAULT_API_HOST = os.environ.get("ALEPH_BOOTSTRAP_API_HOST", "https://api2.aleph.im")
DEFAULT_CHANNEL = os.environ.get("ALEPH_BOOTSTRAP_CHANNEL", "simple-todo")
DEFAULT_REF = os.environ.get("ALEPH_BOOTSTRAP_REF", "simple-todo-bootstrap")
DEFAULT_POST_TYPE = os.environ.get("ALEPH_BOOTSTRAP_POST_TYPE", "relay-bootstrap")
MAX_PREVIOUS_PAGES = int(os.environ.get("ALEPH_BOOTSTRAP_MAX_PREVIOUS_PAGES", "5"))
PAGINATION = int(os.environ.get("ALEPH_BOOTSTRAP_PAGINATION", "50"))


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


def json_dumps(payload: object) -> str:
    return json.dumps(payload, separators=(",", ":"))


def dedupe(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        if value and value not in seen:
            seen.add(value)
            result.append(value)
    return result


def sign_personal_message(private_key: str, payload: str) -> str:
    message = encode_defunct(text=payload)
    signed = Account.sign_message(message, private_key=private_key)
    signature = signed.signature.hex()
    return signature if signature.startswith("0x") else f"0x{signature}"


def address_from_private_key(private_key: str) -> str:
    return Account.from_key(private_key).address


def signature_payload(chain: str, sender: str, message_type: str, item_hash: str) -> str:
    return "\n".join([chain, sender, message_type, item_hash])


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


def is_invalid_message_format(http_status: int, payload: dict) -> bool:
    if http_status != 422:
        return False
    details = payload.get("details")
    if isinstance(details, str) and "InvalidMessageFormat" in details:
        return True
    if isinstance(details, dict):
        message = details.get("message")
        if isinstance(message, str) and "InvalidMessageFormat" in message:
            return True
    return False


def is_retryable_broadcast_failure(http_status: int, payload: dict) -> bool:
    if http_status >= 500:
        return True
    publication_status = payload.get("publication_status")
    if isinstance(publication_status, dict):
        status = publication_status.get("status")
        if isinstance(status, str) and status.strip().lower() == "error":
            return True
    return False


def broadcast_aleph_message(api_host: str, message: dict[str, object]) -> tuple[int, dict]:
    url = urllib.parse.urljoin(api_host.rstrip("/") + "/", "api/v0/messages")
    attempts = [
        {"sync": True, "message": message},
        {**message, "sync": True},
        dict(message),
    ]
    for index, attempt in enumerate(attempts):
        http_status, payload = post_json(url, attempt)
        if 200 <= http_status < 300:
            return http_status, payload
        can_retry = index < len(attempts) - 1 and (
            is_invalid_message_format(http_status, payload)
            or is_retryable_broadcast_failure(http_status, payload)
        )
        if not can_retry:
            raise RuntimeError(f"Aleph broadcast failed: {http_status} {json_dumps(payload)}")
    raise RuntimeError("Aleph broadcast failed: no compatible request format was accepted")


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

    if not isinstance(item_content, dict):
        return None

    content = item_content.get("content")
    if not isinstance(content, dict):
        return None

    return {
        "item_hash": item_hash,
        "sender": sender,
        "registration_id": content.get("registrationId"),
        "peer_id": content.get("peerId"),
    }


def load_peer_id() -> str | None:
    describe = subprocess.run([DESCRIBE_SCRIPT], check=False, capture_output=True, text=True)
    if describe.returncode != 0:
        return None
    try:
        metadata = json.loads(describe.stdout.strip() or "{}")
    except json.JSONDecodeError:
        return None
    peer_id = metadata.get("peer_id")
    if isinstance(peer_id, str) and peer_id.strip():
        return peer_id.strip()
    return None


def fetch_current_hashes(
    api_host: str,
    channel: str,
    ref: str,
    post_type: str,
    sender: str,
    registration_id: str | None,
    peer_id: str | None,
) -> list[str]:
    found: list[str] = []
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
            if str(parsed["sender"]).lower() != sender.lower():
                continue
            if registration_id and parsed["registration_id"] == registration_id:
                found.append(str(parsed["item_hash"]))
                continue
            if peer_id and parsed["peer_id"] == peer_id:
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
            "reason": f"Deregister relay bootstrap records for {sender}",
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

    publisher_address = address_from_private_key(publisher_private_key)
    peer_id = load_peer_id()
    channel = env_values.get("ALEPH_BOOTSTRAP_CHANNEL", DEFAULT_CHANNEL).strip() or DEFAULT_CHANNEL
    ref = env_values.get("ALEPH_BOOTSTRAP_REF", DEFAULT_REF).strip() or DEFAULT_REF
    post_type = env_values.get("ALEPH_BOOTSTRAP_POST_TYPE", DEFAULT_POST_TYPE).strip() or DEFAULT_POST_TYPE
    api_host = env_values.get("ALEPH_BOOTSTRAP_API_HOST", DEFAULT_API_HOST).strip() or DEFAULT_API_HOST

    hashes = fetch_current_hashes(
        api_host,
        channel,
        ref,
        post_type,
        publisher_address,
        registration_id,
        peer_id,
    )
    if not hashes:
        print(json_dumps({"status": "skipped", "reason": "no matching bootstrap records"}))
        return

    http_status, response = broadcast_forget(
        api_host, publisher_address, publisher_private_key, hashes, channel
    ) or (0, {})
    print(
        json_dumps(
            {
                "status": "forgotten",
                "httpStatus": http_status,
                "sender": publisher_address,
                "registrationId": registration_id,
                "peerId": peer_id,
                "forgottenHashes": hashes,
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
