import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

function unique(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

async function readText(filePath) {
  return await readFile(filePath, "utf8");
}

function extractEndpoints(source) {
  const matches = source.match(/\/(?:api|about|v2|control)\/[A-Za-z0-9_./{}:-]+/g) ?? [];
  return unique(matches);
}

function extractHosts(source) {
  const matches = source.match(/https:\/\/[A-Za-z0-9._/-]+/g) ?? [];
  return unique(matches);
}

function createCheck(id, title, severity, passed, details) {
  return { id, title, severity, passed, details };
}

function summarize(checks) {
  const failures = checks.filter((check) => !check.passed && check.severity === "fail");
  const warnings = checks.filter((check) => !check.passed && check.severity === "warn");
  return {
    failures,
    warnings,
    ok: failures.length === 0,
  };
}

function renderCheck(check) {
  const icon = check.passed ? "PASS" : check.severity === "fail" ? "FAIL" : "WARN";
  return `- [${icon}] ${check.title}: ${check.details}`;
}

function renderSection(title, values) {
  if (values.length === 0) {
    return `## ${title}\n\n- none\n`;
  }

  return `## ${title}\n\n${values.map((value) => `- \`${value}\``).join("\n")}\n`;
}

async function main() {
  const upstreamRoot = process.env.ALEPH_RS_DIR;
  if (!upstreamRoot) {
    throw new Error("ALEPH_RS_DIR must point to a checked-out aleph-rs repository.");
  }

  const localPaths = {
    uiController: path.join(repoRoot, "packages/ui/src/shared/controller.ts"),
    coreForget: path.join(repoRoot, "packages/core/src/forget.ts"),
    coreRetention: path.join(repoRoot, "packages/core/src/retention.ts"),
    coreRuntime: path.join(repoRoot, "packages/core/src/runtime.ts"),
    browserApi: path.join(repoRoot, "packages/browser/src/aleph-api.ts"),
    rootfsBuild: path.join(
      repoRoot,
      "packages/rootfs/reference/orbitdb-relay-pinner/rootfs/build-rootfs.sh",
    ),
  };

  const upstreamPaths = {
    readme: path.join(upstreamRoot, "README.md"),
    cli: path.join(upstreamRoot, "crates/aleph-cli/src/cli.rs"),
    instanceCommand: path.join(upstreamRoot, "crates/aleph-cli/src/commands/instance.rs"),
    fileCommand: path.join(upstreamRoot, "crates/aleph-cli/src/commands/file.rs"),
    crnSdk: path.join(upstreamRoot, "crates/aleph-sdk/src/crn.rs"),
  };

  const [
    uiController,
    coreForget,
    coreRetention,
    coreRuntime,
    browserApi,
    rootfsBuild,
    upstreamReadme,
    upstreamCli,
    upstreamInstanceCommand,
    upstreamFileCommand,
    upstreamCrnSdk,
  ] = await Promise.all([
    readText(localPaths.uiController),
    readText(localPaths.coreForget),
    readText(localPaths.coreRetention),
    readText(localPaths.coreRuntime),
    readText(localPaths.browserApi),
    readText(localPaths.rootfsBuild),
    readText(upstreamPaths.readme),
    readText(upstreamPaths.cli),
    readText(upstreamPaths.instanceCommand),
    readText(upstreamPaths.fileCommand),
    readText(upstreamPaths.crnSdk),
  ]);

  const localRelevantSource = [
    uiController,
    coreForget,
    coreRetention,
    coreRuntime,
    browserApi,
    rootfsBuild,
  ].join("\n");
  const upstreamRelevantSource = [
    upstreamReadme,
    upstreamCli,
    upstreamInstanceCommand,
    upstreamFileCommand,
    upstreamCrnSdk,
  ].join("\n");

  const localEndpoints = extractEndpoints(localRelevantSource);
  const upstreamEndpoints = extractEndpoints(upstreamRelevantSource);
  const localHosts = extractHosts(localRelevantSource);
  const upstreamHosts = extractHosts(upstreamRelevantSource);

  const localDeleteBlock = (() => {
    const match = uiController.match(/async deleteInstance\(instanceHash: string\): Promise<void> \{([\s\S]*?)\n  }\n/);
    return match?.[1] ?? "";
  })();

  const checks = [
    createCheck(
      "upstream-instance-delete-requires-erase",
      "Upstream aleph-rs models instance deletion as erase + forget",
      "fail",
      upstreamCli.includes("run `aleph instance erase` first") &&
        upstreamCrnSdk.includes("erase_instance") &&
        upstreamInstanceCommand.includes('crn::handle_operation(scheduler_url, json, args, "erase")'),
      "aleph-rs explicitly exposes and documents CRN erase before FORGET for instances.",
    ),
    createCheck(
      "local-ui-delete-has-erase-step",
      "Shared UI delete flow performs CRN erase before FORGET",
      "fail",
      /erase/i.test(localDeleteBlock),
      "The current UI delete flow only prepares a FORGET message. It does not perform the CRN `/control/machine/{vm_id}/erase` step that aleph-rs requires.",
    ),
    createCheck(
      "local-retention-instance-cleanup-has-erase-step",
      "Retention cleanup erases instances before forgetting them",
      "fail",
      /erase/i.test(coreRetention),
      "The retention path forgets instance hashes directly, but it does not contain an instance erase stage.",
    ),
    createCheck(
      "local-has-crn-signed-operation-support",
      "Shared tooling can sign CRN machine control operations",
      "fail",
      localRelevantSource.includes("X-SignedOperation") && localRelevantSource.includes("/control/machine/"),
      "No local CRN control implementation was found for signed machine operations such as `/control/machine/{vm_id}/erase`.",
    ),
    createCheck(
      "execution-list-fallback-aligned",
      "CRN execution lookup keeps the upstream v2 -> v1 fallback",
      "warn",
      coreRuntime.includes("/v2/about/executions/list") && coreRuntime.includes("/about/executions/list"),
      "This is an alignment check for the CRN execution lookup fallback path.",
    ),
    createCheck(
      "broadcast-endpoint-aligned",
      "Message broadcast still targets `/api/v0/messages`",
      "warn",
      browserApi.includes("/api/v0/messages") && coreForget.includes("FORGET"),
      "This is a sanity check that the shared tooling still posts Aleph messages through the same core endpoint family.",
    ),
    createCheck(
      "default-api-host-aligned",
      "Default CCN host matches upstream README mainnet default",
      "warn",
      browserApi.includes("https://api.aleph.im"),
      "shared-aleph-tooling still defaults to a non-canonical CCN host, while upstream aleph-rs README documents `https://api.aleph.im` as the mainnet default CCN.",
    ),
    createCheck(
      "rootfs-script-not-pinned-to-aleph-client",
      "Rootfs reference script is not pinned to aleph-client wording",
      "warn",
      !rootfsBuild.includes("install aleph-client"),
      "The orbitdb relay pinner rootfs build script still tells users to install `aleph-client` when the Aleph CLI is missing.",
    ),
  ];

  const result = summarize(checks);

  const report = [
    "# Aleph Drift Report",
    "",
    `Generated at: ${new Date().toISOString()}`,
    "",
    `Overall status: ${result.ok ? "clean" : "drift-detected"}`,
    "",
    "## Checks",
    "",
    ...checks.map(renderCheck),
    "",
    renderSection("Local Endpoint Footprint", localEndpoints),
    renderSection("Upstream Endpoint Footprint", upstreamEndpoints),
    renderSection("Local Host Defaults", localHosts),
    renderSection("Upstream Host Defaults", upstreamHosts),
  ].join("\n");

  if (process.env.REPORT_PATH) {
    await writeFile(process.env.REPORT_PATH, report);
  }

  console.log(report);

  if (!result.ok) {
    process.exitCode = 1;
  }
}

await main();
