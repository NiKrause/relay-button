import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { chmodSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIGURE_SCRIPT = path.resolve(
  TEST_DIR,
  "../reference/ucan-store/rootfs/ucan-store-configure.sh",
);

type RunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

async function makeTempDir(prefix: string) {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function writeExecutable(filePath: string, content: string) {
  await writeFile(filePath, content, "utf8");
  chmodSync(filePath, 0o755);
}

async function writeMockValidator(filePath: string, logPath: string) {
  await writeExecutable(
    filePath,
    `#!/usr/bin/env python3
import json
import sys
from pathlib import Path

Path(${JSON.stringify(logPath)}).parent.mkdir(parents=True, exist_ok=True)
with open(${JSON.stringify(logPath)}, "a", encoding="utf-8") as handle:
    handle.write(json.dumps(sys.argv[1:]) + "\\n")
`,
  );
}

async function writeMockVerifier(filePath: string, logPath: string) {
  await writeExecutable(
    filePath,
    `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
fs.mkdirSync(path.dirname(${JSON.stringify(logPath)}), { recursive: true });
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");
const summaryIndex = args.indexOf("--summary-file");
if (summaryIndex !== -1 && args[summaryIndex + 1]) {
  fs.writeFileSync(
    args[summaryIndex + 1],
    JSON.stringify({ status: "ok", args }, null, 2),
    "utf8",
  );
}
`,
  );
}

async function writeMockSystemctl(binDir: string, logPath: string) {
  await writeExecutable(
    path.join(binDir, "systemctl"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}
`,
  );
}

async function runConfigure(
  args: string[],
  extraEnv: Record<string, string>,
): Promise<RunResult> {
  const env = {
    ...process.env,
    ...extraEnv,
  };

  return await new Promise((resolve, reject) => {
    const child = spawn("/bin/bash", [CONFIGURE_SCRIPT, ...args], {
      env,
      cwd: path.resolve("."),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

async function readJsonLines(filePath: string): Promise<string[][]> {
  const raw = await readFile(filePath, "utf8");
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

function envValue(rawEnv: string, key: string): string | null {
  const match = rawEnv.match(new RegExp(`^${key}=(.*)$`, "m"));
  return match ? match[1] : null;
}

test("ucan-store-configure installs bootstrap inputs and writes public env without starting services", async (t) => {
  const tempDir = await makeTempDir("ucan-store-configure-no-start-");
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const binDir = path.join(tempDir, "bin");
  await mkdir(binDir, { recursive: true });

  const envFile = path.join(tempDir, "ucan-store.env");
  const readyFile = path.join(tempDir, "ucan-store.ready");
  const caddyFile = path.join(tempDir, "Caddyfile");
  const bootstrapInputFile = path.join(tempDir, "bootstrap-input.json");
  const bootstrapPackageFile = path.join(tempDir, "bootstrap-package.json");
  const bootstrapVerificationFile = path.join(tempDir, "bootstrap-verification.json");
  const validatorLog = path.join(tempDir, "validator.log");
  const verifierLog = path.join(tempDir, "verifier.log");
  const systemctlLog = path.join(tempDir, "systemctl.log");
  const validatorScript = path.join(tempDir, "validator.py");
  const verifierScript = path.join(tempDir, "verifier.mjs");

  await writeMockSystemctl(binDir, systemctlLog);
  await writeMockValidator(validatorScript, validatorLog);
  await writeMockVerifier(verifierScript, verifierLog);

  await writeFile(
    bootstrapInputFile,
    JSON.stringify(
      {
        adminDid: "did:key:z6Mkadmin123",
        serviceDid: "did:web:upload.example.com",
        spaceDid: "did:key:z6Mkspace123",
        rootDelegationProof: "mproof-placeholder",
        allowedCapabilities: ["store/add", "upload/add"],
      },
      null,
      2,
    ),
    "utf8",
  );

  const result = await runConfigure(
    [
      "--public-ipv4",
      "203.0.113.20",
      "--proxy-hostname",
      "upload.example.com",
      "--admin-did",
      "did:key:z6Mkadmin123",
      "--admin-api-token",
      "super-secret",
      "--bootstrap-package-file",
      bootstrapInputFile,
      "--no-start",
    ],
    {
      ENV_FILE: envFile,
      READY_FILE: readyFile,
      BOOTSTRAP_PACKAGE_FILE: bootstrapPackageFile,
      BOOTSTRAP_VALIDATOR: validatorScript,
      BOOTSTRAP_CRYPTO_VERIFIER: verifierScript,
      BOOTSTRAP_VERIFICATION_FILE: bootstrapVerificationFile,
      CADDYFILE: caddyFile,
      SERVICE_GROUP: "ucan-store-test-missing-group",
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    },
  );

  assert.equal(result.code, 0, result.stderr || result.stdout);
  const rawEnv = await readFile(envFile, "utf8");
  assert.equal(envValue(rawEnv, "PUBLIC_UPLOAD_SERVICE_URL"), "https://upload.example.com");
  assert.equal(envValue(rawEnv, "PUBLIC_REVOCATION_URL"), "https://upload.example.com");
  assert.equal(envValue(rawEnv, "PUBLIC_RECEIPTS_URL"), "https://upload.example.com/receipt/");
  assert.equal(envValue(rawEnv, "UCAN_STORE_SERVICE_ORIGIN"), "https://upload.example.com");
  assert.equal(envValue(rawEnv, "UCAN_STORE_PUBLIC_STORAGE_ORIGIN"), "https://upload.example.com");
  assert.equal(envValue(rawEnv, "UCAN_STORE_SERVICE_DID"), "did:web:upload.example.com");
  assert.equal(envValue(rawEnv, "UCAN_STORE_ADMIN_DID"), "did:key:z6Mkadmin123");
  assert.equal(envValue(rawEnv, "UCAN_STORE_ADMIN_API_TOKEN"), "super-secret");

  const installedBootstrap = await readFile(bootstrapPackageFile, "utf8");
  assert.match(installedBootstrap, /"serviceDid": "did:web:upload\.example\.com"/u);
  const bootstrapMode = (await stat(bootstrapPackageFile)).mode & 0o777;
  assert.equal(bootstrapMode, 0o644);
  const verificationSummary = await readFile(bootstrapVerificationFile, "utf8");
  assert.match(verificationSummary, /"status": "ok"/u);
  const verificationMode = (await stat(bootstrapVerificationFile)).mode & 0o777;
  assert.equal(verificationMode, 0o666);
  const caddy = await readFile(caddyFile, "utf8");
  assert.match(caddy, /upload\.example\.com/u);
  assert.match(caddy, /reverse_proxy 127\.0\.0\.1:8788/u);

  const validatorCalls = await readJsonLines(validatorLog);
  const verifierCalls = await readJsonLines(verifierLog);
  assert.deepEqual(validatorCalls, [["--package-file", bootstrapInputFile]]);
  assert.deepEqual(verifierCalls, [[
    "--package-file",
    bootstrapInputFile,
    "--admin-did",
    "did:key:z6Mkadmin123",
    "--summary-file",
    bootstrapVerificationFile,
  ]]);

  await assert.rejects(readFile(systemctlLog, "utf8"));
  assert.equal(await readFile(readyFile, "utf8"), "");
});

test("ucan-store-configure preserves explicit custom service identity without proxy hostname", async (t) => {
  const tempDir = await makeTempDir("ucan-store-configure-explicit-service-");
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const binDir = path.join(tempDir, "bin");
  await mkdir(binDir, { recursive: true });

  const envFile = path.join(tempDir, "ucan-store.env");
  const readyFile = path.join(tempDir, "ucan-store.ready");
  const caddyFile = path.join(tempDir, "Caddyfile");
  const bootstrapInputFile = path.join(tempDir, "bootstrap-input.json");
  const bootstrapPackageFile = path.join(tempDir, "bootstrap-package.json");
  const bootstrapVerificationFile = path.join(tempDir, "bootstrap-verification.json");
  const validatorLog = path.join(tempDir, "validator.log");
  const verifierLog = path.join(tempDir, "verifier.log");
  const systemctlLog = path.join(tempDir, "systemctl.log");
  const validatorScript = path.join(tempDir, "validator.py");
  const verifierScript = path.join(tempDir, "verifier.mjs");

  await writeMockSystemctl(binDir, systemctlLog);
  await writeMockValidator(validatorScript, validatorLog);
  await writeMockVerifier(verifierScript, verifierLog);

  await writeFile(
    bootstrapInputFile,
    JSON.stringify(
      {
        adminDid: "did:key:z6Mkadmin123",
        serviceDid: "did:web:ucan-api.nicokrause.com",
        serviceOrigin: "https://ucan-api.nicokrause.com",
        spaceDid: "did:key:z6Mkspace123",
        rootDelegationProof: "mproof-placeholder",
        allowedCapabilities: ["store/add", "upload/add"],
      },
      null,
      2,
    ),
    "utf8",
  );

  const result = await runConfigure(
    [
      "--public-ipv4",
      "203.0.113.20",
      "--service-did",
      "did:web:ucan-api.nicokrause.com",
      "--service-origin",
      "https://ucan-api.nicokrause.com/",
      "--public-storage-origin",
      "https://reserved-proxy.example.2n6.me/",
      "--admin-did",
      "did:key:z6Mkadmin123",
      "--bootstrap-package-file",
      bootstrapInputFile,
      "--no-start",
    ],
    {
      ENV_FILE: envFile,
      READY_FILE: readyFile,
      BOOTSTRAP_PACKAGE_FILE: bootstrapPackageFile,
      BOOTSTRAP_VALIDATOR: validatorScript,
      BOOTSTRAP_CRYPTO_VERIFIER: verifierScript,
      BOOTSTRAP_VERIFICATION_FILE: bootstrapVerificationFile,
      CADDYFILE: caddyFile,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    },
  );

  assert.equal(result.code, 0, result.stderr || result.stdout);
  const rawEnv = await readFile(envFile, "utf8");
  assert.equal(envValue(rawEnv, "PROXY_HOSTNAME"), "");
  assert.equal(envValue(rawEnv, "UCAN_STORE_SERVICE_DID"), "did:web:ucan-api.nicokrause.com");
  assert.equal(envValue(rawEnv, "PUBLIC_UPLOAD_SERVICE_URL"), "https://ucan-api.nicokrause.com");
  assert.equal(envValue(rawEnv, "PUBLIC_REVOCATION_URL"), "https://ucan-api.nicokrause.com");
  assert.equal(envValue(rawEnv, "PUBLIC_RECEIPTS_URL"), "https://ucan-api.nicokrause.com/receipt/");
  assert.equal(envValue(rawEnv, "UCAN_STORE_SERVICE_ORIGIN"), "https://ucan-api.nicokrause.com");
  assert.equal(envValue(rawEnv, "UCAN_STORE_PUBLIC_STORAGE_ORIGIN"), "https://reserved-proxy.example.2n6.me");

  const validatorCalls = await readJsonLines(validatorLog);
  const verifierCalls = await readJsonLines(verifierLog);
  assert.deepEqual(validatorCalls, [["--package-file", bootstrapInputFile]]);
  assert.deepEqual(verifierCalls, [[
    "--package-file",
    bootstrapInputFile,
    "--admin-did",
    "did:key:z6Mkadmin123",
    "--summary-file",
    bootstrapVerificationFile,
  ]]);

  await assert.rejects(readFile(caddyFile, "utf8"));
  await assert.rejects(readFile(systemctlLog, "utf8"));
  assert.equal(await readFile(readyFile, "utf8"), "");
});

test("ucan-store-configure serves proxy and custom service hostnames through Caddy", async (t) => {
  const tempDir = await makeTempDir("ucan-store-configure-dual-caddy-");
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const binDir = path.join(tempDir, "bin");
  await mkdir(binDir, { recursive: true });

  const envFile = path.join(tempDir, "ucan-store.env");
  const readyFile = path.join(tempDir, "ucan-store.ready");
  const caddyFile = path.join(tempDir, "Caddyfile");
  const systemctlLog = path.join(tempDir, "systemctl.log");

  await writeMockSystemctl(binDir, systemctlLog);

  const result = await runConfigure(
    [
      "--public-ipv4",
      "203.0.113.20",
      "--proxy-hostname",
      "reserved-proxy.example.2n6.me",
      "--service-did",
      "did:web:ucan-api.nicokrause.com",
      "--service-origin",
      "https://ucan-api.nicokrause.com/",
      "--admin-did",
      "did:key:z6Mkadmin123",
      "--no-start",
    ],
    {
      ENV_FILE: envFile,
      READY_FILE: readyFile,
      CADDYFILE: caddyFile,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    },
  );

  assert.equal(result.code, 0, result.stderr || result.stdout);
  const rawEnv = await readFile(envFile, "utf8");
  assert.equal(envValue(rawEnv, "PROXY_HOSTNAME"), "reserved-proxy.example.2n6.me");
  assert.equal(envValue(rawEnv, "UCAN_STORE_SERVICE_HOSTNAME"), "ucan-api.nicokrause.com");
  assert.equal(envValue(rawEnv, "UCAN_STORE_SERVICE_DID"), "did:web:ucan-api.nicokrause.com");
  assert.equal(envValue(rawEnv, "PUBLIC_UPLOAD_SERVICE_URL"), "https://ucan-api.nicokrause.com");
  assert.equal(envValue(rawEnv, "UCAN_STORE_SERVICE_ORIGIN"), "https://ucan-api.nicokrause.com");
  assert.equal(envValue(rawEnv, "UCAN_STORE_PUBLIC_STORAGE_ORIGIN"), "https://ucan-api.nicokrause.com");

  const caddy = await readFile(caddyFile, "utf8");
  assert.match(caddy, /reserved-proxy\.example\.2n6\.me, ucan-api\.nicokrause\.com/u);
  assert.match(caddy, /reverse_proxy 127\.0\.0\.1:8788/u);
  assert.doesNotMatch(caddy, /auto_https disable_redirects/u);
  await assert.rejects(readFile(systemctlLog, "utf8"));
  assert.equal(await readFile(readyFile, "utf8"), "");
});

test("ucan-store-configure re-verifies bootstrap inputs against runtime DID and origin after start", async (t) => {
  const tempDir = await makeTempDir("ucan-store-configure-runtime-");
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const binDir = path.join(tempDir, "bin");
  await mkdir(binDir, { recursive: true });

  const envFile = path.join(tempDir, "ucan-store.env");
  const readyFile = path.join(tempDir, "ucan-store.ready");
  const caddyFile = path.join(tempDir, "Caddyfile");
  const bootstrapInputFile = path.join(tempDir, "bootstrap-input.json");
  const bootstrapPackageFile = path.join(tempDir, "bootstrap-package.json");
  const bootstrapVerificationFile = path.join(tempDir, "bootstrap-verification.json");
  const validatorLog = path.join(tempDir, "validator.log");
  const verifierLog = path.join(tempDir, "verifier.log");
  const systemctlLog = path.join(tempDir, "systemctl.log");
  const validatorScript = path.join(tempDir, "validator.py");
  const verifierScript = path.join(tempDir, "verifier.mjs");

  await writeMockSystemctl(binDir, systemctlLog);
  await writeMockValidator(validatorScript, validatorLog);
  await writeMockVerifier(verifierScript, verifierLog);

  await writeFile(
    bootstrapInputFile,
    JSON.stringify(
      {
        adminDid: "did:key:z6Mkadmin123",
        serviceDid: "did:web:upload.example.com",
        serviceOrigin: "https://upload.example.com",
        spaceDid: "did:key:z6Mkspace123",
        rootDelegationProof: "mproof-placeholder",
        allowedCapabilities: ["store/add", "upload/add"],
      },
      null,
      2,
    ),
    "utf8",
  );

  const didServer = http.createServer((req, res) => {
    if (req.url === "/.well-known/did.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "did:web:upload.example.com" }));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  didServer.listen(0, "127.0.0.1");
  await once(didServer, "listening");
  t.after(() => {
    didServer.close();
  });

  const address = didServer.address();
  assert.ok(address && typeof address === "object");
  const servicePort = String(address.port);

  const result = await runConfigure(
    [
      "--public-ipv4",
      "203.0.113.20",
      "--proxy-hostname",
      "upload.example.com",
      "--admin-did",
      "did:key:z6Mkadmin123",
      "--admin-api-token",
      "super-secret",
      "--bootstrap-package-file",
      bootstrapInputFile,
    ],
    {
      ENV_FILE: envFile,
      READY_FILE: readyFile,
      BOOTSTRAP_PACKAGE_FILE: bootstrapPackageFile,
      BOOTSTRAP_VALIDATOR: validatorScript,
      BOOTSTRAP_CRYPTO_VERIFIER: verifierScript,
      BOOTSTRAP_VERIFICATION_FILE: bootstrapVerificationFile,
      CADDYFILE: caddyFile,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      SERVICE_PORT: servicePort,
    },
  );

  assert.equal(result.code, 0, result.stderr || result.stdout);

  const rawEnv = await readFile(envFile, "utf8");
  assert.equal(envValue(rawEnv, "UCAN_STORE_SERVICE_DID"), "did:web:upload.example.com");
  assert.equal(envValue(rawEnv, "PUBLIC_UPLOAD_SERVICE_DID"), "did:web:upload.example.com");
  assert.equal(envValue(rawEnv, "PUBLIC_REVOCATION_DID"), "did:web:upload.example.com");

  const validatorCalls = await readJsonLines(validatorLog);
  const verifierCalls = await readJsonLines(verifierLog);
  assert.equal(validatorCalls.length, 2);
  assert.equal(verifierCalls.length, 2);
  assert.deepEqual(validatorCalls[0], ["--package-file", bootstrapInputFile]);
  assert.deepEqual(validatorCalls[1], [
    "--package-file",
    bootstrapPackageFile,
    "--runtime-service-did",
    "did:web:upload.example.com",
    "--runtime-service-origin",
    "https://upload.example.com",
    "--admin-did",
    "did:key:z6Mkadmin123",
  ]);
  assert.deepEqual(verifierCalls[1], [
    "--package-file",
    bootstrapPackageFile,
    "--runtime-service-did",
    "did:web:upload.example.com",
    "--runtime-service-origin",
    "https://upload.example.com",
    "--admin-did",
    "did:key:z6Mkadmin123",
    "--summary-file",
    bootstrapVerificationFile,
  ]);
  const verificationMode = (await stat(bootstrapVerificationFile)).mode & 0o777;
  assert.equal(verificationMode, 0o666);

  const systemctlCalls = await readFile(systemctlLog, "utf8");
  assert.match(systemctlCalls, /^daemon-reload$/mu);
  assert.match(systemctlCalls, /^restart ucan-store\.service$/mu);
  assert.match(systemctlCalls, /^restart caddy\.service$/mu);
});
