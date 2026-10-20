import assert from "node:assert/strict";
import test from "node:test";

import {
  githubRunnerDeployEnv,
  githubRunnerGuestFiles,
  githubRunnerName,
  githubRunnerNamePrefix,
  mergeForgetAuthorization,
  parseGithubRunnerArgs,
  readDeployedRunnerVm,
  selectSweepableRunners,
} from "../src/github-runner.ts";

const hash = "ab".repeat(32);

test("up needs a repository and a published image, and caps the count", () => {
  assert.throws(() => parseGithubRunnerArgs(["up"], {}), /--repo owner\/name/);
  assert.throws(() => parseGithubRunnerArgs(["up", "--repo", "o/r"], {}), /--rootfs/);
  assert.throws(() => parseGithubRunnerArgs(["up", "--repo", "o/r", "--rootfs", hash, "--count", "11"], {}), /capped/);
  assert.throws(() => parseGithubRunnerArgs(["up", "--repo", "o/r", "--rootfs", hash, "--ttl", "0"], {}), /positive integer/);
  const options = parseGithubRunnerArgs(["up", "--repo", "o/r", "--count", "2", "--labels", "aleph, big"], {
    GH_RUNNER_ROOTFS_ITEM_HASH: hash,
  });
  assert.equal(options.count, 2);
  assert.deepEqual(options.labels, ["aleph", "big"]);
  assert.equal(options.rootfsItemHash, hash);
  assert.equal(options.allowPublic, false);
});

test("down takes exact INSTANCE hashes or --all", () => {
  assert.throws(() => parseGithubRunnerArgs(["down"], {}), /--all or one or more/);
  assert.throws(() => parseGithubRunnerArgs(["down", "abc"], {}), /Not an INSTANCE item hash/);
  assert.deepEqual(parseGithubRunnerArgs(["down", hash], {}).instances, [hash]);
  assert.throws(() => parseGithubRunnerArgs(["sideways"], {}), /Unknown gh-runner command/);
});

test("runner names are scoped to the repository and fit GitHub's limit", () => {
  const name = githubRunnerName("Le-Space/Paperless_Anywhere", new Date("2026-10-20T12:34:56Z"), 3);
  assert.equal(name, "gh-runner-le-space-paperless-anywhere-20261020123456-3");
  assert.ok(name.startsWith(githubRunnerNamePrefix("Le-Space/Paperless_Anywhere")));
  assert.ok(githubRunnerName("o/" + "x".repeat(80), new Date(), 1).length <= 64);
});

test("deploy env publishes only SSH and skips relay configuration", () => {
  const env = githubRunnerDeployEnv({
    privateKey: "0xkey",
    name: "gh-runner-o-r-1-1",
    sshPublicKey: "ssh-ed25519 AAAA",
    rootfsItemHash: hash,
    vcpus: 2,
    memoryMiB: 4096,
    diskMiB: 40960,
  });
  assert.equal(env.ALEPH_VM_PROFILE, "github-runner");
  assert.equal(env.ALEPH_VM_AUTO_CONFIGURE, "false");
  assert.deepEqual(JSON.parse(env.ALEPH_VM_REQUIRED_PORTS_JSON).map((port: { port: number }) => port.port), [22]);
});

test("a scaffold deploy result is never taken for a running VM", () => {
  assert.throws(() => readDeployedRunnerVm({ status: "scaffold" }), /no INSTANCE item hash/);
  assert.throws(() => readDeployedRunnerVm({ itemHash: hash, runtime: { hostIpv4: "192.0.2.1", mappedPorts: {} } }), /SSH port/);
  assert.deepEqual(
    readDeployedRunnerVm({
      itemHash: hash,
      runtime: { hostIpv4: "192.0.2.1", mappedPorts: { "22": { host: 24001 } }, selectedCrn: { name: "crn" } },
    }),
    { itemHash: hash, host: "192.0.2.1", sshPort: 24001, crnName: "crn" },
  );
});

test("guest files end with the jitconfig, which starts the runner", () => {
  const files = githubRunnerGuestFiles({
    jitConfig: "jit",
    ttlMinutes: 90,
    forget: { key: "0xforget", owner: "0xowner", instance: hash },
  });
  assert.deepEqual(files.map((file) => file.path), [
    "/etc/github-runner/ttl",
    "/etc/github-runner/forget.env",
    "/etc/github-runner/jitconfig",
  ]);
  assert.match(files[1].content, new RegExp(`ALEPH_INSTANCE=${hash}`));
  assert.equal(githubRunnerGuestFiles({ jitConfig: "jit", ttlMinutes: 90 }).length, 2);
});

test("the forget key gets FORGET only, and other authorizations survive", () => {
  const pwa = { address: "0xPWA", types: ["INSTANCE"], aggregate_keys: ["port-forwarding"] };
  const merged = mergeForgetAuthorization([pwa, { address: "0xforget", types: ["INSTANCE", "FORGET"] }], "0xFORGET");
  assert.deepEqual(merged, [pwa, { address: "0xFORGET", types: ["FORGET"] }]);
  assert.deepEqual(mergeForgetAuthorization(merged, "0xforget", true), [pwa]);
});

test("janitor sweeps finished and expired runners, never a booting one or a stranger", () => {
  const prefix = "gh-runner-o-r-";
  const now = 10 * 60 * 60_000;
  const at = (minutesAgo: number) => now - minutesAgo * 60_000;
  const candidates = [
    { itemHash: "1", name: `${prefix}a`, createdAt: at(5) },
    { itemHash: "2", name: `${prefix}b`, createdAt: at(30) },
    { itemHash: "3", name: `${prefix}c`, createdAt: at(30) },
    { itemHash: "4", name: `${prefix}d`, createdAt: at(400) },
    { itemHash: "5", name: "gh-runner-other-repo-e", createdAt: at(400) },
  ];
  const swept = selectSweepableRunners({
    candidates,
    prefix,
    githubRunnerNames: new Set([`${prefix}c`, `${prefix}d`]),
    now,
    ttlMs: 375 * 60_000,
  });
  assert.deepEqual(swept.map((candidate) => candidate.itemHash), ["2", "4"]);
});
