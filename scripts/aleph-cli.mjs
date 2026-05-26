#!/usr/bin/env node

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const nodeRunner = path.join(repoRoot, "packages/node/src/action-runner.ts");
const rootfsRunner = path.join(repoRoot, "packages/node/src/rootfs-runner.ts");

function printHelp() {
  console.log(`shared-aleph-tooling CLI

Usage:
  pnpm aleph <command>

Commands:
  deploy            Deploy a VM from a published rootfs item hash
  list-crns         List geocoded CRNs using the shared action runner
  retain            Retain only the latest successful deployments
  rootfs-plan       Print the derived rootfs build plan from a rootfs contract
  rootfs-build      Build a rootfs image without publishing it
  rootfs-publish    Build and optionally publish a rootfs image
  help              Show this help

Examples:
  pnpm aleph deploy
  pnpm aleph rootfs-publish

Required environment for deploy:
  ALEPH_VM_PRIVATE_KEY
  ALEPH_VM_NAME
  ALEPH_VM_SSH_PUBLIC_KEY
  ALEPH_VM_ROOTFS_ITEM_HASH
    or ALEPH_VM_ROOTFS_MANIFEST_URL

Required environment for rootfs-publish:
  ALEPH_ROOTFS_PROJECT_DIR
  ALEPH_ROOTFS_CONTRACT_PATH

Typical optional environment:
  ALEPH_VM_PROFILE
  ALEPH_VM_ROOTFS_MANIFEST_URL
  ALEPH_VM_ROOTFS_VERSION
  ALEPH_VM_ROOTFS_SIZE_MIB
  ALEPH_VM_VCPUS
  ALEPH_VM_MEMORY_MIB
  ALEPH_VM_CRN_HASH
  ALEPH_VM_PREFERRED_COUNTRY_CODE
  ALEPH_VM_REQUIRED_PORTS_JSON
  ALEPH_ROOTFS_VERSION
  ALEPH_ROOTFS_SKIP_UPLOAD
  ALEPH_ROOTFS_SKIP_BUILD
  ALEPH_ROOTFS_ORBITDB_RELAY_PINNER_DIR

This CLI is a thin wrapper around:
  - packages/node/src/action-runner.ts
  - packages/node/src/rootfs-runner.ts
`);
}

function resolveCommand(argv) {
  const [command] = argv;
  switch (command) {
    case "deploy":
      return {
        script: nodeRunner,
        env: { ALEPH_VM_MODE: "deploy" },
      };
    case "list-crns":
      return {
        script: nodeRunner,
        env: { ALEPH_VM_MODE: "list-crns" },
      };
    case "retain":
      return {
        script: nodeRunner,
        env: { ALEPH_VM_MODE: "retain-successful-deployments" },
      };
    case "rootfs-plan":
      return {
        script: rootfsRunner,
        env: { ALEPH_VM_MODE: "rootfs-build-plan" },
      };
    case "rootfs-build":
      return {
        script: rootfsRunner,
        env: { ALEPH_VM_MODE: "rootfs-build" },
      };
    case "rootfs-publish":
      return {
        script: rootfsRunner,
        env: { ALEPH_VM_MODE: "rootfs-publish" },
      };
    case "help":
    case "--help":
    case "-h":
    case undefined:
      return null;
    default:
      throw new Error(`Unknown command "${command}". Run "pnpm aleph help".`);
  }
}

async function main() {
  const [, , ...argv] = process.argv;
  const resolved = resolveCommand(argv);
  if (!resolved) {
    printHelp();
    return;
  }

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [resolved.script], {
      cwd: repoRoot,
      env: { ...process.env, ...resolved.env },
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with exit code ${code ?? "unknown"}`));
      }
    });
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
