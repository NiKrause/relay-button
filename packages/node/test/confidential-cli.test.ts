import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  attestAndUnlock,
  createConfidentialInstance,
  isPermanentAttestationFailure,
  parseInstanceItemHash,
  type AlephCliRunner,
} from "../src/confidential-cli.ts";
import { parseDeployPlan } from "../src/deploy-plan.ts";

const ITEM_HASH = "a".repeat(64);
const KEY = "0x" + "1".repeat(64);

function recorder(answers: Array<{ stdout?: string; stderr?: string } | Error>) {
  const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv; files: Record<string, string> }> = [];
  const run: AlephCliRunner = async (args, options) => {
    const files: Record<string, string> = {};
    for (const flag of ["--ssh-pubkey-file", "--passphrase-file"]) {
      const index = args.indexOf(flag);
      if (index >= 0) files[flag] = await readFile(args[index + 1]!, "utf8");
    }
    calls.push({ args, env: options.env, files });
    const answer = answers.shift() ?? {};
    if (answer instanceof Error) throw answer;
    return { stdout: answer.stdout ?? "", stderr: answer.stderr ?? "" };
  };
  return { run, calls };
}

test("parseInstanceItemHash reads the CLI's create output", () => {
  assert.equal(parseInstanceItemHash(`Message processed (INSTANCE)\n  Item hash: ${ITEM_HASH}\n`), ITEM_HASH);
  assert.equal(parseInstanceItemHash("Error: File too large"), null);
});

test("createConfidentialInstance pins the node, keeps the key out of argv", async () => {
  const { run, calls } = recorder([{ stderr: `Message processed (INSTANCE)\n  Item hash: ${ITEM_HASH}\n` }]);
  const itemHash = await createConfidentialInstance({
    run,
    privateKey: KEY,
    name: "relay",
    rootfsItemHash: "b".repeat(64),
    rootfsSizeMiB: 20480,
    vcpus: 2,
    memoryMiB: 4096,
    crnHash: "c".repeat(64),
    sshPublicKey: "ssh-ed25519 AAAATest relay@example",
    channel: "TEST",
  });
  assert.equal(itemHash, ITEM_HASH);
  const { args, env, files } = calls[0]!;
  assert.deepEqual(args.slice(0, 5), ["instance", "create", "relay", "--confidential", "--image"]);
  assert.equal(args[args.indexOf("--crn") + 1], "c".repeat(64));
  assert.equal(args[args.indexOf("--memory") + 1], "4096MiB");
  assert.ok(!args.join(" ").includes("1111111111"), "the private key must not be on the command line");
  assert.equal(env.ALEPH_PRIVATE_KEY, "1".repeat(64));
  assert.equal(files["--ssh-pubkey-file"], "ssh-ed25519 AAAATest relay@example\n");
});

test("attestAndUnlock retries the attestation, then injects the passphrase", async () => {
  const attested = JSON.stringify({ verified: true, measurement: "d".repeat(96), policy: "0x30000" });
  const { run, calls } = recorder([new Error("RA-TLS HTTP request failed"), { stdout: attested }, {}]);
  const result = await attestAndUnlock({
    run,
    privateKey: KEY,
    itemHash: ITEM_HASH,
    crnHash: "c".repeat(64),
    luksPassphrase: "correct horse battery staple\n",
    attempts: 3,
    delayMs: 0,
    sleep: async () => {},
    log: () => {},
  });
  assert.equal(result.verified, true);
  assert.equal(result.policy, "0x30000");
  assert.deepEqual(calls.map((call) => call.args[1]), ["attest", "attest", "unlock"]);
  assert.equal(calls[2]!.files["--passphrase-file"], "correct horse battery staple");
  assert.ok(!calls[2]!.args.includes("correct horse battery staple"));
});

test("attestAndUnlock sends nothing when the attestation does not verify", async () => {
  const { run, calls } = recorder([{ stdout: JSON.stringify({ verified: false }) }]);
  await assert.rejects(
    attestAndUnlock({
      run,
      privateKey: KEY,
      itemHash: ITEM_HASH,
      crnHash: "c".repeat(64),
      luksPassphrase: "secret",
      attempts: 1,
      delayMs: 0,
      sleep: async () => {},
      log: () => {},
    }),
    /did not verify; the passphrase was not sent/,
  );
  assert.deepEqual(calls.map((call) => call.args[1]), ["attest"]);
});

test("parseDeployPlan reads the confidential settings", () => {
  const plan = parseDeployPlan({
    ALEPH_VM_PRIVATE_KEY: KEY,
    ALEPH_VM_NAME: "relay",
    ALEPH_VM_SSH_PUBLIC_KEY: "ssh-ed25519 AAAATest relay@example",
    ALEPH_VM_ROOTFS_ITEM_HASH: "b".repeat(64),
    ALEPH_VM_CONFIDENTIAL: "true",
    ALEPH_VM_LUKS_PASSPHRASE: "secret",
  });
  assert.equal(plan.confidential, true);
  assert.equal(plan.luksPassphrase, "secret");
  assert.equal(plan.alephCli, "aleph");
  assert.equal(parseDeployPlan({ ALEPH_VM_PRIVATE_KEY: KEY, ALEPH_VM_NAME: "r", ALEPH_VM_SSH_PUBLIC_KEY: "ssh-ed25519 AAAATest", ALEPH_VM_ROOTFS_ITEM_HASH: "b".repeat(64) }).confidential, false);
});

test("a node that cannot be trusted is refused at once, not retried", async () => {
  const floor = new Error("aleph instance attest failed: Error: attestation failed: SEV-SNP TCB below the required floor: launch TCB below floor (Bootloader 7<9, Microcode 22<25)");
  const { run, calls } = recorder([floor, floor, floor]);
  await assert.rejects(
    attestAndUnlock({
      run,
      privateKey: KEY,
      itemHash: ITEM_HASH,
      crnHash: "c".repeat(64),
      luksPassphrase: "secret",
      attempts: 3,
      delayMs: 0,
      sleep: async () => {},
      log: () => {},
    }),
    /TCB below the required floor/,
  );
  assert.equal(calls.length, 1);
  assert.equal(isPermanentAttestationFailure("failed to fetch VCEK certificate from AMD KDS: AMD KDS returned HTTP 404 Not Found"), true);
  assert.equal(isPermanentAttestationFailure("RA-TLS HTTP request failed: error sending request"), false);
});
