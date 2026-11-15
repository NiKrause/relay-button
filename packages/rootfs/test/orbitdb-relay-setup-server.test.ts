import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const SETUP_SERVER = fileURLToPath(
  new URL("../reference/orbitdb-relay/rootfs/orbitdb-relay-setup-server.py", import.meta.url),
);
const PYTHON = process.env.PYTHON ?? "python3";
const SSH_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyMaterialOnlyForTests nico@example";

// Runs `_configure_refusal(secret, payload)` in the setup server against a
// temporary authorized_keys and env file, and returns its answer.
async function refusal(args: {
  authorizedKeys: string;
  secret?: string | null;
  payload?: Record<string, unknown>;
  env?: string;
}): Promise<{ refusal: string | null; ethAccount: boolean }> {
  const dir = await mkdtemp(path.join(tmpdir(), "orbitdb-setup-"));
  try {
    const keysFile = path.join(dir, "authorized_keys");
    const envFile = path.join(dir, "env");
    await writeFile(keysFile, args.authorizedKeys);
    await writeFile(envFile, args.env ?? "");
    const program = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("setup_server", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
try:
    import eth_account  # noqa: F401
    eth = True
except ImportError:
    eth = False
print(json.dumps({"refusal": module._configure_refusal(json.loads(sys.argv[2]), json.loads(sys.argv[3])), "ethAccount": eth}))
`;
    const { stdout } = await execFileAsync(
      PYTHON,
      ["-c", program, SETUP_SERVER, JSON.stringify(args.secret ?? null), JSON.stringify(args.payload ?? {})],
      { env: { ...process.env, AUTHORIZED_KEYS_FILE: keysFile, ENV_FILE: envFile } },
    );
    return JSON.parse(stdout);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const OWNER = "0x2bd014b41fea490320187b5fadf413dab88f7628";
const secret = "a".repeat(64);
const digest = createHash("sha256").update(secret).digest("hex");
const markedKeys = `${SSH_KEY} aleph-setup:${OWNER}:${digest}\n`;

test("a guest deployed without a setup marker accepts configuration as before", async () => {
  const result = await refusal({ authorizedKeys: `${SSH_KEY}\n` });
  assert.equal(result.refusal, null);
});

test("a marked guest accepts the deployer's secret and refuses anything else", async () => {
  assert.equal((await refusal({ authorizedKeys: markedKeys, secret })).refusal, null);
  assert.match(String((await refusal({ authorizedKeys: markedKeys, secret: "b".repeat(64) })).refusal), /setup secret/);
  assert.match(String((await refusal({ authorizedKeys: markedKeys })).refusal), /setup secret/);
});

// Signs with eth-account, as the relay image would verify with it. Without
// eth-account (not installed on CI runners) the case is skipped.
test("a marked guest accepts an owner authorization for the publisher key it installs", async (t) => {
  const program = `
import base64, hashlib, importlib.util, json, os, sys, tempfile
try:
    from eth_account import Account
    from eth_account.messages import encode_defunct
except ImportError:
    print(json.dumps({"skip": True}))
    sys.exit(0)

owner, publisher, stranger = Account.create(), Account.create(), Account.create()
directory = tempfile.mkdtemp()
keys_file = os.path.join(directory, "authorized_keys")
env_file = os.path.join(directory, "env")
digest = hashlib.sha256(b"${secret}").hexdigest()
with open(keys_file, "w") as handle:
    handle.write("${SSH_KEY} aleph-setup:%s:%s\\n" % (owner.address.lower(), digest))
os.environ["AUTHORIZED_KEYS_FILE"] = keys_file
os.environ["ENV_FILE"] = env_file
open(env_file, "w").close()

spec = importlib.util.spec_from_file_location("setup_server", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

payload = {
    "ownerAddress": owner.address,
    "publisherAddress": publisher.address,
    "peerId": "12D3KooWTestPeer",
    "registrationId": "relay:orbitdb-relay:orbitdb-relay:hash",
    "profile": "orbitdb-relay",
    "instanceItemHash": "hash",
    "issuedAt": 1794743425554,
}

def authorization(signer):
    message = json.dumps(payload, separators=(",", ":"))
    signature = signer.sign_message(encode_defunct(text=message)).signature.hex()
    record = {"scheme": "personal_sign", "payload": payload, "signature": "0x" + signature.removeprefix("0x")}
    return base64.b64encode(json.dumps(record).encode()).decode()

results = {
    "valid": module._configure_refusal(None, {
        "bootstrap_publisher_private_key": publisher.key.hex(),
        "bootstrap_owner_authorization_b64": authorization(owner),
    }),
    "stranger": module._configure_refusal(None, {
        "bootstrap_publisher_private_key": publisher.key.hex(),
        "bootstrap_owner_authorization_b64": authorization(stranger),
    }),
    "replayed": module._configure_refusal(None, {
        "bootstrap_publisher_private_key": Account.create().key.hex(),
        "bootstrap_owner_authorization_b64": authorization(owner),
    }),
}
with open(env_file, "w") as handle:
    handle.write("ALEPH_BOOTSTRAP_PUBLISHER_PRIVATE_KEY=%s\\n" % publisher.key.hex())
results["second_pass"] = module._configure_refusal(None, {
    "bootstrap_owner_authorization_b64": authorization(owner),
})
print(json.dumps(results))
`;
  const { stdout } = await execFileAsync(PYTHON, ["-c", program, SETUP_SERVER]);
  const results = JSON.parse(stdout);
  if (results.skip) {
    t.skip("eth-account is not installed here; the relay image has it");
    return;
  }
  assert.equal(results.valid, null);
  // Signed by someone other than the owner in the marker.
  assert.match(String(results.stranger), /setup secret/);
  // The owner's authorization, replayed with a different publisher key.
  assert.match(String(results.replayed), /does not name the publisher key/);
  // No key in the request: the publisher key already installed counts.
  assert.equal(results.second_pass, null);
});
