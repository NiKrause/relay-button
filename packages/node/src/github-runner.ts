// Pure helpers for scripts/aleph-github-runner.mjs: ephemeral GitHub Actions
// runners on plain Aleph VMs built from the `github-runner` rootfs profile.
// Network and SSH live in the script; everything here is testable offline.

export const GITHUB_RUNNER_PROFILE = "github-runner";
export const GITHUB_RUNNER_NAME_PREFIX = "gh-runner-";
// A just-in-time runner gets exactly the labels it is given: GitHub does not
// add `self-hosted`, `Linux` and `X64` as it does for a registered runner, so
// a job on `[self-hosted, aleph]` would wait forever without them.
export const GITHUB_RUNNER_BASE_LABELS = ["self-hosted", "Linux", "X64"];
export const GITHUB_RUNNER_DEFAULT_LABELS = ["aleph"];

export function githubRunnerLabels(labels: string[]): string[] {
  const seen = new Set<string>();
  return [...GITHUB_RUNNER_BASE_LABELS, ...labels].filter((label) => {
    const key = label.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
export const GITHUB_RUNNER_PORTS = [
  { port: 22, tcp: true, udp: false, purpose: "SSH bootstrap and diagnostics" },
];

export interface GithubRunnerOptions {
  command: "up" | "list" | "down" | "janitor" | "authorize-forget" | "help";
  repo: string;
  count: number;
  labels: string[];
  ttlMinutes: number;
  vcpus: number;
  memoryMiB: number;
  diskMiB: number;
  rootfsItemHash: string;
  allowPublic: boolean;
  all: boolean;
  instances: string[];
  revoke: boolean;
  sshKey: string;
}

const COMMANDS = new Set(["up", "list", "down", "janitor", "authorize-forget", "help"]);

function positiveInteger(flag: string, raw: string | undefined): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${flag} needs a positive integer, got "${raw ?? ""}"`);
  return value;
}

export function parseGithubRunnerArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): GithubRunnerOptions {
  const [command = "help", ...rest] = argv;
  if (!COMMANDS.has(command)) throw new Error(`Unknown gh-runner command "${command}"`);
  const options: GithubRunnerOptions = {
    command: command as GithubRunnerOptions["command"],
    repo: env.GH_RUNNER_REPO?.trim() ?? "",
    count: 1,
    labels: [...GITHUB_RUNNER_DEFAULT_LABELS],
    ttlMinutes: 360,
    vcpus: 2,
    memoryMiB: 4096,
    diskMiB: 40960,
    rootfsItemHash: env.GH_RUNNER_ROOTFS_ITEM_HASH?.trim() ?? "",
    allowPublic: false,
    all: false,
    instances: [],
    revoke: false,
    sshKey: "",
  };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    const next = () => {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      index += 1;
      return value;
    };
    switch (arg) {
      case "--repo": options.repo = next(); break;
      case "--count": options.count = positiveInteger(arg, next()); break;
      case "--labels": options.labels = next().split(",").map((label) => label.trim()).filter(Boolean); break;
      case "--ttl": options.ttlMinutes = positiveInteger(arg, next()); break;
      case "--vcpus": options.vcpus = positiveInteger(arg, next()); break;
      case "--memory": options.memoryMiB = positiveInteger(arg, next()); break;
      case "--disk": options.diskMiB = positiveInteger(arg, next()); break;
      case "--rootfs": options.rootfsItemHash = next(); break;
      case "--allow-public": options.allowPublic = true; break;
      case "--all": options.all = true; break;
      case "--revoke": options.revoke = true; break;
      case "--ssh-key": options.sshKey = next(); break;
      default:
        if (arg.startsWith("--")) throw new Error(`Unknown option ${arg}`);
        options.instances.push(arg);
    }
  }
  if (["up", "list", "janitor"].includes(options.command) && !/^[\w.-]+\/[\w.-]+$/u.test(options.repo)) {
    throw new Error("--repo owner/name is required");
  }
  if (options.command === "up") {
    if (!/^[a-f0-9]{64}$/u.test(options.rootfsItemHash)) {
      throw new Error("--rootfs <github-runner STORE item hash> (or GH_RUNNER_ROOTFS_ITEM_HASH) is required");
    }
    if (options.labels.length === 0) {
      throw new Error("--labels must name at least one label");
    }
    if (options.count > 10) throw new Error("--count is capped at 10 runners per call");
  }
  for (const hash of options.instances) {
    if (!/^[a-f0-9]{64}$/u.test(hash)) throw new Error(`Not an INSTANCE item hash: ${hash}`);
  }
  if (options.command === "down" && !options.all && options.instances.length === 0) {
    throw new Error("down needs --all or one or more INSTANCE item hashes");
  }
  return options;
}

/** `gh-runner-<owner>-<repo>-<yyyymmddhhmmss>-<n>`, also the GitHub runner name. */
export function githubRunnerName(repo: string, now: Date, index: number): string {
  const slug = repo.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
  const stamp = now.toISOString().replace(/\D/gu, "").slice(0, 14);
  return `${GITHUB_RUNNER_NAME_PREFIX}${slug}-${stamp}-${index}`.slice(0, 64);
}

export function githubRunnerNamePrefix(repo: string): string {
  const slug = repo.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
  return `${GITHUB_RUNNER_NAME_PREFIX}${slug}-`;
}

/** Environment for packages/node/src/action-runner.ts in deploy mode. */
export function githubRunnerDeployEnv(args: {
  privateKey: string;
  name: string;
  sshPublicKey: string;
  rootfsItemHash: string;
  vcpus: number;
  memoryMiB: number;
  diskMiB: number;
  apiHosts?: string[];
}): Record<string, string> {
  return {
    ALEPH_VM_MODE: "deploy",
    ALEPH_VM_PROFILE: GITHUB_RUNNER_PROFILE,
    ALEPH_VM_PRIVATE_KEY: args.privateKey,
    ALEPH_VM_NAME: args.name,
    ALEPH_VM_SSH_PUBLIC_KEY: args.sshPublicKey,
    ALEPH_VM_ROOTFS_ITEM_HASH: args.rootfsItemHash,
    ALEPH_VM_ROOTFS_VERSION: GITHUB_RUNNER_PROFILE,
    ALEPH_VM_ROOTFS_SIZE_MIB: String(args.diskMiB),
    ALEPH_VM_VCPUS: String(args.vcpus),
    ALEPH_VM_MEMORY_MIB: String(args.memoryMiB),
    ALEPH_VM_API_HOSTS: (args.apiHosts ?? ["https://api2.aleph.im", "https://api.aleph.im"]).join(","),
    ALEPH_VM_PLACEMENT_STRATEGY: "manual",
    ALEPH_VM_MAX_CRN_ATTEMPTS: "5",
    ALEPH_VM_AUTO_CONFIGURE: "false",
    ALEPH_VM_VERIFY_REACHABILITY: "false",
    ALEPH_VM_PUBLISH_PORT_FORWARDS: "true",
    ALEPH_VM_REQUIRED_PORTS_JSON: JSON.stringify(GITHUB_RUNNER_PORTS),
  };
}

export interface DeployedRunnerVm {
  itemHash: string;
  host: string;
  sshPort: number;
  crnName: string;
}

/**
 * The deploy runner falls back to a scaffold result when an environment
 * variable is missing; a launcher must never treat that as a running VM.
 */
export function readDeployedRunnerVm(result: {
  itemHash?: string;
  status?: string;
  runtime?: { hostIpv4?: string | null; mappedPorts?: Record<string, { host?: number | string }> ; selectedCrn?: { name?: string } | null } | null;
  selectedCrn?: { name?: string } | null;
}): DeployedRunnerVm {
  const itemHash = result.itemHash ?? "";
  if (!/^[a-f0-9]{64}$/u.test(itemHash)) throw new Error(`Deploy returned no INSTANCE item hash (status ${result.status ?? "unknown"})`);
  const host = result.runtime?.hostIpv4 ?? "";
  const sshPort = Number(result.runtime?.mappedPorts?.["22"]?.host);
  if (!host || !Number.isInteger(sshPort) || sshPort <= 0) {
    throw new Error(`INSTANCE ${itemHash} has no host IPv4 and SSH port mapping yet`);
  }
  return {
    itemHash,
    host,
    sshPort,
    crnName: result.runtime?.selectedCrn?.name ?? result.selectedCrn?.name ?? "",
  };
}

/** Files the launcher writes into /etc/github-runner, jitconfig last: the guest starts on it. */
export function githubRunnerGuestFiles(args: {
  jitConfig: string;
  ttlMinutes: number;
  forget?: { key: string; owner: string; instance: string; apiHost?: string } | null;
}): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = [
    { path: "/etc/github-runner/ttl", content: `${args.ttlMinutes}\n` },
  ];
  if (args.forget) {
    const lines = [
      `ALEPH_FORGET_KEY=${args.forget.key}`,
      `ALEPH_OWNER=${args.forget.owner}`,
      `ALEPH_INSTANCE=${args.forget.instance}`,
    ];
    if (args.forget.apiHost) lines.push(`ALEPH_API_HOST=${args.forget.apiHost}`);
    files.push({ path: "/etc/github-runner/forget.env", content: `${lines.join("\n")}\n` });
  }
  files.push({ path: "/etc/github-runner/jitconfig", content: args.jitConfig });
  return files;
}

export interface SecurityAuthorization {
  address: string;
  types?: string[];
  [key: string]: unknown;
}

/**
 * Aleph replaces the whole `security` aggregate's authorization list, so a
 * change has to carry every other entry along.
 *
 * FORGET alone is not enough: Aleph lets a delegate forget only what it
 * "could have created under the owner's security aggregate" (measured
 * 2026-10-21, relay-button#191), so the key also needs INSTANCE. That lets it
 * start VMs paid by the owner, which is why the runner wallet holds nothing
 * else and only a small balance.
 */
export function mergeForgetAuthorization(
  current: SecurityAuthorization[],
  forgetAddress: string,
  revoke = false,
): SecurityAuthorization[] {
  const others = current.filter((entry) => entry.address.toLowerCase() !== forgetAddress.toLowerCase());
  return revoke ? others : [...others, { address: forgetAddress, types: ["INSTANCE", "FORGET"] }];
}

export interface RunnerInstanceCandidate {
  itemHash: string;
  name: string;
  createdAt: number;
}

/**
 * A runner VM is swept when GitHub no longer lists its runner (the job ran,
 * the runner deregistered) and it is older than the grace period that covers
 * a VM still booting, or when it outlived its TTL.
 */
export function selectSweepableRunners(args: {
  candidates: RunnerInstanceCandidate[];
  prefix: string;
  githubRunnerNames: Set<string>;
  now: number;
  bootGraceMs?: number;
  ttlMs: number;
}): RunnerInstanceCandidate[] {
  const grace = args.bootGraceMs ?? 15 * 60_000;
  return args.candidates.filter((candidate) => {
    if (!candidate.name.startsWith(args.prefix)) return false;
    const age = args.now - candidate.createdAt;
    if (age > args.ttlMs) return true;
    return age > grace && !args.githubRunnerNames.has(candidate.name);
  });
}
