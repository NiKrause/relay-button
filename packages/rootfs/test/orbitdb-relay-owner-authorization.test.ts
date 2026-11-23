import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const REFRESH = fileURLToPath(
  new URL("../reference/orbitdb-relay/rootfs/orbitdb-relay-bootstrap-refresh.py", import.meta.url),
);

// Made-up addresses and peer IDs.
const OWNER = "0x00000000000000000000000000000000000000c1";
const PUBLISHER = "0x00000000000000000000000000000000000000d1";
const PEER = "12D3KooWAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEW_PEER = "12D3KooWBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

async function ownerFields(
  env: Record<string, string>,
  authorization: unknown,
  publisher: string,
  peerId: string,
) {
  const program = `
import importlib.util, json, sys, types
# owner_fields signs nothing: eth-account, which the guest has, is stubbed here.
eth = types.ModuleType("eth_account")
eth.Account = object
messages = types.ModuleType("eth_account.messages")
messages.encode_defunct = lambda **_: None
eth.messages = messages
sys.modules.setdefault("eth_account", eth)
sys.modules.setdefault("eth_account.messages", messages)
spec = importlib.util.spec_from_file_location("refresh", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
owner, authorization = module.owner_fields(
    json.loads(sys.argv[2]), json.loads(sys.argv[3]), sys.argv[4], sys.argv[5]
)
print(json.dumps({"owner": owner, "authorization": authorization}))
`;
  const { stdout, stderr } = await execFileAsync("python3", [
    "-c",
    program,
    REFRESH,
    JSON.stringify(env),
    JSON.stringify(authorization),
    publisher,
    peerId,
  ]);
  return { ...(JSON.parse(stdout) as { owner: string | null; authorization: unknown }), stderr };
}

const authorization = (peerId: string) => ({
  scheme: "personal_sign",
  payload: { ownerAddress: OWNER, publisherAddress: PUBLISHER, peerId, issuedAt: 1 },
  signature: "0x00",
});

test("an owner authorization for this relay names its owner", async () => {
  const auth = authorization(PEER);
  const result = await ownerFields({}, auth, PUBLISHER.toUpperCase().replace("0X", "0x"), PEER);
  assert.equal(result.owner, OWNER);
  assert.deepEqual(result.authorization, auth);
});

test("an owner address without an authorization is not named", async () => {
  const result = await ownerFields({ ALEPH_BOOTSTRAP_OWNER_ADDRESS: OWNER }, null, PUBLISHER, PEER);
  assert.equal(result.owner, null);
  assert.equal(result.authorization, null);
  assert.match(result.stderr, /names no owner/);
});

test("an authorization for another peer ID or publisher names no owner", async () => {
  // A relay that came back with a new identity keeps the authorization of its first one.
  const stale = await ownerFields({}, authorization(PEER), PUBLISHER, NEW_PEER);
  assert.equal(stale.owner, null);
  assert.equal(stale.authorization, null);
  const other = await ownerFields(
    {},
    authorization(PEER),
    "0x00000000000000000000000000000000000000d2",
    PEER,
  );
  assert.equal(other.owner, null);
});

test("no owner configured stays without one, quietly", async () => {
  const result = await ownerFields({}, null, PUBLISHER, PEER);
  assert.equal(result.owner, null);
  assert.equal(result.stderr, "");
});
