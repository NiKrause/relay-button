#!/usr/bin/env node
// Ephemeral GitHub Actions runners on plain Aleph VMs (relay-button#191).
//
//   pnpm relay-button gh-runner up --repo owner/name [--count N] [--labels aleph] [--ttl 360]
//   pnpm relay-button gh-runner list --repo owner/name
//   pnpm relay-button gh-runner down <instance-hash…> | --all
//   pnpm relay-button gh-runner janitor --repo owner/name
//   pnpm relay-button gh-runner authorize-forget [--revoke]
//
// Environment:
//   ALEPH_VM_PRIVATE_KEY        the runner wallet (owner and payer of the VMs)
//   GH_RUNNER_ROOTFS_ITEM_HASH  published github-runner STORE hash (or --rootfs)
//   GH_RUNNER_FORGET_KEY        optional delegate key, authorized for INSTANCE+FORGET;
//                               with it each VM forgets itself after its job
//   GITHUB_TOKEN                optional; defaults to `gh auth token`
//
// Needs no hosted Actions minutes: it runs wherever Node, ssh and the keys are.
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  GITHUB_RUNNER_NAME_PREFIX,
  githubRunnerDeployEnv,
  githubRunnerGuestFiles,
  githubRunnerLabels,
  githubRunnerName,
  githubRunnerNamePrefix,
  mergeForgetAuthorization,
  parseGithubRunnerArgs,
  readDeployedRunnerVm,
  selectSweepableRunners,
} from "../packages/node/src/github-runner.ts";
import { runActionMode } from "../packages/node/src/action-runner.ts";
import { createPrivateKeyIdentity } from "../packages/node/src/signer.ts";
import {
  eraseInstanceOnCrn,
  forgetAlephMessages,
  publishAggregateKey,
} from "../packages/core/src/index.ts";
import { waitForAlephInstanceDeletion } from "../packages/playwright/src/index.ts";

const run = promisify(execFile);
const API_HOSTS = ["https://api2.aleph.im", "https://api.aleph.im"];
const hasher = (content) => createHash("sha256").update(content).digest("hex");
const log = (...parts) => console.error("[gh-runner]", ...parts);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function help() {
  console.log(`Usage:
  gh-runner up --repo owner/name [--count N] [--labels aleph] [--ttl 360]
               [--vcpus 2] [--memory 4096] [--disk 40960] [--rootfs <hash>] [--allow-public] [--ssh-key <path>]
  gh-runner list --repo owner/name
  gh-runner down <instance-hash…> | --all
  gh-runner janitor --repo owner/name
  gh-runner authorize-forget [--revoke]

Environment: ALEPH_VM_PRIVATE_KEY, GH_RUNNER_ROOTFS_ITEM_HASH, GH_RUNNER_FORGET_KEY (optional), GITHUB_TOKEN (optional, else gh auth token)`);
}

async function githubToken() {
  if (process.env.GITHUB_TOKEN?.trim()) return process.env.GITHUB_TOKEN.trim();
  try {
    const { stdout } = await run("gh", ["auth", "token"]);
    if (stdout.trim()) return stdout.trim();
  } catch {
    // fall through
  }
  throw new Error("No GitHub token: set GITHUB_TOKEN or log in with `gh auth login`");
}

async function github(token, method, route, body) {
  const response = await fetch(`https://api.github.com${route}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`GitHub ${method} ${route}: HTTP ${response.status} ${payload.message ?? ""}`);
  return payload;
}

async function githubRunners(token, repo) {
  const runners = [];
  for (let page = 1; page < 20; page += 1) {
    const payload = await github(token, "GET", `/repos/${repo}/actions/runners?per_page=100&page=${page}`);
    runners.push(...payload.runners);
    if (payload.runners.length < 100) break;
  }
  return runners;
}

async function ownerIdentity() {
  const key = process.env.ALEPH_VM_PRIVATE_KEY?.trim();
  if (!key) throw new Error("ALEPH_VM_PRIVATE_KEY (the runner wallet) is required");
  return { key, ...(await createPrivateKeyIdentity(key)) };
}

async function runnerInstances(owner) {
  const url = new URL("/api/v0/messages.json", API_HOSTS[0]);
  url.searchParams.set("msgTypes", "INSTANCE");
  url.searchParams.set("addresses", owner);
  url.searchParams.set("message_statuses", "processed,pending");
  url.searchParams.set("pagination", "200");
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Aleph INSTANCE inventory failed: HTTP ${response.status}`);
  const payload = await response.json();
  return (payload.messages ?? [])
    .map((message) => ({
      itemHash: String(message.item_hash ?? ""),
      name: String(message.content?.metadata?.name ?? ""),
      createdAt: Number(message.time ?? 0) * 1000,
    }))
    .filter((candidate) => candidate.name.startsWith(GITHUB_RUNNER_NAME_PREFIX));
}

async function ssh(keyPath, vm, command, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ssh",
      [
        "-i", keyPath,
        "-p", String(vm.sshPort),
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "LogLevel=ERROR",
        "-o", "ConnectTimeout=10",
        "-o", "BatchMode=yes",
        `root@${vm.host}`,
        command,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(stdout) : reject(new Error(`ssh exited ${code}: ${stderr.trim()}`))));
    child.stdin.end(input ?? "");
  });
}

async function waitForSsh(keyPath, vm) {
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    try {
      await ssh(keyPath, vm, "test -x /usr/local/sbin/github-runner-start");
      return;
    } catch (error) {
      if (attempt === 60) throw new Error(`SSH to ${vm.host}:${vm.sshPort} never came up: ${error.message}`);
      await sleep(5000);
    }
  }
}

async function removeVm(identity, itemHash, reason) {
  for (const apiHost of API_HOSTS) {
    try {
      await eraseInstanceOnCrn({ sender: identity.address, signer: identity.signer, instanceHash: itemHash, fetch, apiHost });
      break;
    } catch {
      // FORGET below is what ends the allocation and the billing.
    }
  }
  let forgotten = null;
  for (const apiHost of API_HOSTS) {
    try {
      forgotten = await forgetAlephMessages({
        sender: identity.address,
        hashes: [itemHash],
        reason,
        signer: identity.signer,
        hasher,
        fetch,
        apiHost,
        sync: true,
      });
      if (forgotten.status === "rejected") throw new Error("FORGET rejected");
      break;
    } catch {
      forgotten = null;
    }
  }
  if (!forgotten) throw new Error(`Could not FORGET INSTANCE ${itemHash}`);
  await waitForAlephInstanceDeletion({ instanceHash: itemHash, apiHosts: API_HOSTS, fetch });
  return forgotten.itemHash;
}

async function up(options) {
  const token = await githubToken();
  const repo = await github(token, "GET", `/repos/${options.repo}`);
  if (!repo.private && !options.allowPublic) {
    throw new Error(`${options.repo} is public: a self-hosted runner there would run code from forks. Pass --allow-public only if its workflows never run for outside pull requests.`);
  }
  const identity = await ownerIdentity();
  const forgetKey = process.env.GH_RUNNER_FORGET_KEY?.trim() || "";
  if (!forgetKey) log("GH_RUNNER_FORGET_KEY not set: the VMs power off after their job but stay allocated until `down` or `janitor`.");

  // A one-run SSH identity, deleted afterwards; --ssh-key keeps your own for
  // diagnosing a runner that misbehaves.
  const workDir = await mkdtemp(path.join(tmpdir(), "gh-runner-"));
  const keyPath = options.sshKey || path.join(workDir, "id");
  if (!options.sshKey) await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "gh-runner", "-f", keyPath]);
  const sshPublicKey = (await readFile(`${keyPath}.pub`, "utf8")).trim();
  const now = new Date();

  const started = [];
  try {
    for (let index = 1; index <= options.count; index += 1) {
      const name = githubRunnerName(options.repo, now, index);
      log(`${name}: deploying`);
      let output = "";
      await runActionMode(
        {
          ...process.env,
          GITHUB_OUTPUT: "",
          GITHUB_STEP_SUMMARY: "",
          ...githubRunnerDeployEnv({
            privateKey: identity.key,
            name,
            sshPublicKey,
            rootfsItemHash: options.rootfsItemHash,
            vcpus: options.vcpus,
            memoryMiB: options.memoryMiB,
            diskMiB: options.diskMiB,
            apiHosts: API_HOSTS,
          }),
        },
        { stdout: (text) => (output += text) },
      );
      const vm = readDeployedRunnerVm(JSON.parse(output.trim().split("\n").pop()));
      log(`${name}: INSTANCE ${vm.itemHash} on ${vm.crnName || "?"}, SSH ${vm.host}:${vm.sshPort}`);
      try {
        await waitForSsh(keyPath, vm);
        const jit = await github(token, "POST", `/repos/${options.repo}/actions/runners/generate-jitconfig`, {
          name,
          runner_group_id: 1,
          labels: githubRunnerLabels(options.labels),
          work_folder: "_work",
        });
        const files = githubRunnerGuestFiles({
          jitConfig: jit.encoded_jit_config,
          ttlMinutes: options.ttlMinutes,
          forget: forgetKey ? { key: forgetKey, owner: identity.address, instance: vm.itemHash, apiHost: API_HOSTS[0] } : null,
        });
        for (const file of files) {
          await ssh(keyPath, vm, `umask 077 && cat > ${file.path}.tmp && mv ${file.path}.tmp ${file.path}`, file.content);
        }
        await waitForOnline(token, options.repo, jit.runner.id, name);
        started.push({ name, instance: vm.itemHash, runnerId: jit.runner.id, crn: vm.crnName });
      } catch (error) {
        log(`${name}: ${error.message}; removing the VM`);
        await removeVm(identity, vm.itemHash, `github-runner ${name} failed to start`).catch((cleanupError) =>
          log(`${name}: cleanup failed too, run janitor: ${cleanupError.message}`),
        );
        throw error;
      }
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ repo: options.repo, labels: githubRunnerLabels(options.labels), runners: started }, null, 2));
}

async function waitForOnline(token, repo, runnerId, name) {
  for (let attempt = 1; attempt <= 36; attempt += 1) {
    const runner = await github(token, "GET", `/repos/${repo}/actions/runners/${runnerId}`).catch(() => null);
    if (runner?.status === "online") {
      log(`${name}: online${runner.busy ? ", already busy" : ", waiting for a job"}`);
      return;
    }
    await sleep(5000);
  }
  throw new Error(`runner ${name} did not come online on GitHub`);
}

async function list(options) {
  const token = await githubToken();
  const identity = await ownerIdentity();
  const [instances, runners] = await Promise.all([runnerInstances(identity.address), githubRunners(token, options.repo)]);
  const byName = new Map(runners.map((runner) => [runner.name, runner]));
  const prefix = githubRunnerNamePrefix(options.repo);
  const rows = instances
    .filter((instance) => instance.name.startsWith(prefix))
    .map((instance) => {
      const runner = byName.get(instance.name);
      return {
        instance: instance.itemHash,
        name: instance.name,
        ageMinutes: Math.round((Date.now() - instance.createdAt) / 60_000),
        github: runner ? `${runner.status}${runner.busy ? " busy" : ""}` : "gone",
      };
    });
  console.log(JSON.stringify(rows, null, 2));
}

async function down(options) {
  const identity = await ownerIdentity();
  const targets = options.all ? (await runnerInstances(identity.address)).map((instance) => instance.itemHash) : options.instances;
  const removed = [];
  for (const itemHash of targets) {
    log(`removing ${itemHash}`);
    removed.push({ instance: itemHash, forget: await removeVm(identity, itemHash, "github-runner down") });
  }
  console.log(JSON.stringify({ removed }, null, 2));
}

async function janitor(options) {
  const token = await githubToken();
  const identity = await ownerIdentity();
  const [instances, runners] = await Promise.all([runnerInstances(identity.address), githubRunners(token, options.repo)]);
  const sweep = selectSweepableRunners({
    candidates: instances,
    prefix: githubRunnerNamePrefix(options.repo),
    githubRunnerNames: new Set(runners.map((runner) => runner.name)),
    now: Date.now(),
    ttlMs: (options.ttlMinutes + 15) * 60_000,
  });
  const removed = [];
  for (const candidate of sweep) {
    log(`sweeping ${candidate.name} (${candidate.itemHash})`);
    removed.push({ ...candidate, forget: await removeVm(identity, candidate.itemHash, "github-runner janitor") });
  }
  // Offline runners whose VM is gone would otherwise linger in the repo settings.
  const swept = new Set(sweep.map((candidate) => candidate.itemHash));
  const live = new Set(instances.filter((instance) => !swept.has(instance.itemHash)).map((instance) => instance.name));
  for (const runner of runners) {
    if (runner.name.startsWith(GITHUB_RUNNER_NAME_PREFIX) && runner.status === "offline" && !live.has(runner.name)) {
      await github(token, "DELETE", `/repos/${options.repo}/actions/runners/${runner.id}`);
      log(`deregistered offline runner ${runner.name}`);
    }
  }
  console.log(JSON.stringify({ removed }, null, 2));
}

async function authorizeForget(options) {
  const identity = await ownerIdentity();
  const forgetKey = process.env.GH_RUNNER_FORGET_KEY?.trim();
  if (!forgetKey) throw new Error("GH_RUNNER_FORGET_KEY is required");
  const forget = await createPrivateKeyIdentity(forgetKey);
  if (forget.address.toLowerCase() === identity.address.toLowerCase()) {
    throw new Error("GH_RUNNER_FORGET_KEY must be a separate key, not the runner wallet itself");
  }
  const response = await fetch(`${API_HOSTS[0]}/api/v0/aggregates/${identity.address}.json?keys=security`, { cache: "no-store" });
  const current = response.ok ? ((await response.json()).data?.security?.authorizations ?? []) : [];
  const authorizations = mergeForgetAuthorization(current, forget.address, options.revoke);
  const result = await publishAggregateKey({
    sender: identity.address,
    key: "security",
    content: { authorizations },
    signer: identity.signer,
    hasher,
    fetch,
    apiHost: API_HOSTS[0],
  });
  console.log(JSON.stringify({ owner: identity.address, forgetKey: forget.address, revoked: options.revoke, aggregate: result.itemHash, status: result.status }, null, 2));
}

const commands = { up, list, down, janitor, "authorize-forget": authorizeForget, help };
try {
  const options = parseGithubRunnerArgs(process.argv.slice(2));
  await commands[options.command](options);
} catch (error) {
  log(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
