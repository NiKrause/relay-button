#!/usr/bin/env node
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_WEB_ROOT = process.env.WEB_ROOT || '/opt/ucan-store/web';
const DEFAULT_BIND_HOST = process.env.UCAN_STORE_PROXY_HOST || '127.0.0.1';
const DEFAULT_BIND_PORT = Number.parseInt(process.env.UCAN_STORE_PROXY_PORT || '8788', 10);
const DEFAULT_UPSTREAM_PORT = Number.parseInt(process.env.STORACHA_LOCAL_PORT || '8787', 10);
const DEFAULT_BOOTSTRAP_PACKAGE_FILE =
  process.env.UCAN_STORE_BOOTSTRAP_PACKAGE_FILE || '/etc/ucan-store/bootstrap-package.json';
const DEFAULT_REQUIRE_BOOTSTRAP =
  process.env.UCAN_STORE_REQUIRE_BOOTSTRAP_PACKAGE || '1';

function printHelp() {
  console.log(`Usage:
  ucan-store-request-guard.mjs

Environment:
  UCAN_STORE_PROXY_HOST            Bind host (default: 127.0.0.1)
  UCAN_STORE_PROXY_PORT            Bind port (default: 8788)
  STORACHA_LOCAL_PORT              Upstream upload-service port (default: 8787)
  UCAN_STORE_BOOTSTRAP_PACKAGE_FILE  Bootstrap package path
  UCAN_STORE_REQUIRE_BOOTSTRAP_PACKAGE  Enforce bootstrap package presence (default: 1)`);
}

function normalizeString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parsePackageSpecifier(specifier) {
  if (specifier.startsWith('@')) {
    const [scope, name, ...rest] = specifier.split('/');
    return {
      pkgName: `${scope}/${name}`,
      subpath: rest.length ? `./${rest.join('/')}` : '.',
    };
  }
  const [name, ...rest] = specifier.split('/');
  return {
    pkgName: name,
    subpath: rest.length ? `./${rest.join('/')}` : '.',
  };
}

async function resolveExportTarget(pkgRoot, subpath) {
  const packageJsonPath = path.join(pkgRoot, 'package.json');
  const raw = await fs.readFile(packageJsonPath, 'utf8');
  const pkg = JSON.parse(raw);
  const exportsField = pkg.exports;

  if (!exportsField) {
    return pkg.main ? path.join(pkgRoot, pkg.main) : null;
  }

  let target = null;
  if (typeof exportsField === 'string') {
    target = subpath === '.' ? exportsField : null;
  } else if (exportsField[subpath]) {
    target = exportsField[subpath];
  } else if (subpath === '.' && exportsField['.']) {
    target = exportsField['.'];
  }

  if (!target) {
    return null;
  }
  if (typeof target === 'string') {
    return path.join(pkgRoot, target);
  }

  const entry = target.import ?? target.default ?? target.require ?? null;
  return entry ? path.join(pkgRoot, entry) : null;
}

async function resolveFromWebNodeModules(webRoot, specifier) {
  const { pkgName, subpath } = parsePackageSpecifier(specifier);
  const pkgRoot = path.join(webRoot, 'node_modules', pkgName);
  return resolveExportTarget(pkgRoot, subpath);
}

function buildModuleLoader(webRoot) {
  const packageJsonUrl = pathToFileURL(path.join(webRoot, 'package.json')).href;

  return async (specifier) => {
    let resolved = null;
    if (typeof import.meta.resolve === 'function') {
      try {
        const resolvedUrl = import.meta.resolve(specifier, packageJsonUrl);
        resolved = resolvedUrl.startsWith('file://')
          ? new URL(resolvedUrl)
          : pathToFileURL(resolvedUrl);
      } catch {
        resolved = null;
      }
    }
    if (!resolved) {
      const pathResolved = await resolveFromWebNodeModules(webRoot, specifier);
      if (!pathResolved) {
        throw new Error(`Unable to resolve ${specifier} from ${webRoot}/node_modules`);
      }
      resolved = pathToFileURL(pathResolved);
    }
    return import(resolved.href);
  };
}

async function withMutedConsoleLog(fn) {
  const originalLog = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = originalLog;
  }
}

function capabilityCovers(provided, required) {
  if (provided === '*' || provided === required) {
    return true;
  }
  if (provided.endsWith('/*')) {
    const prefix = provided.slice(0, -1);
    return required.startsWith(prefix);
  }
  return false;
}

function isTruthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

async function parseDelegationProof(proof, importFromWeb) {
  const base64UrlToBase64 = (value) => {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const remainder = normalized.length % 4;
    return remainder === 0 ? normalized : normalized + '='.repeat(4 - remainder);
  };
  const bytes = proof.startsWith('m')
    ? new Uint8Array(Buffer.from(proof.slice(1), 'base64'))
    : proof.startsWith('u')
      ? new Uint8Array(Buffer.from(base64UrlToBase64(proof.slice(1)), 'base64'))
      : null;
  if (!bytes) {
    throw new Error('Unsupported bootstrap proof format');
  }

  try {
    const { extract } = await importFromWeb('@ucanto/core/delegation');
    const extracted = await withMutedConsoleLog(() => extract(bytes));
    if (extracted?.ok) {
      return extracted.ok;
    }
    if (extracted && !extracted.error) {
      return extracted;
    }
  } catch {
    // Fall back to Storacha proof parsing.
  }

  const Proof = await importFromWeb('@storacha/client/proof');
  return withMutedConsoleLog(() => Proof.parse(proof));
}

function collectProofCids(proofs, seen = new Set()) {
  for (const proof of proofs ?? []) {
    const cid =
      proof?.cid?.toString?.() ??
      (typeof proof?.toString === 'function' ? proof.toString() : null);
    if (cid && !seen.has(cid)) {
      seen.add(cid);
      collectProofCids(proof?.proofs ?? [], seen);
    }
  }
  return seen;
}

async function loadBootstrapPolicy(args) {
  const raw = await fs.readFile(args.packageFile, 'utf8');
  const payload = JSON.parse(raw);
  const importFromWeb = buildModuleLoader(args.webRoot);
  const delegation = await parseDelegationProof(payload.rootDelegationProof, importFromWeb);

  return {
    importFromWeb,
    rootDelegationCid: delegation?.cid?.toString?.() ?? null,
    delegation,
    package: payload,
    spaceDid: normalizeString(payload.spaceDid),
    allowedCapabilities: Array.isArray(payload.allowedCapabilities)
      ? payload.allowedCapabilities.map(normalizeString).filter(Boolean)
      : [],
  };
}

async function proxyRequest(req, res, config, bodyBuffer = null) {
  const url = new URL(req.url || '/', `http://${config.upstreamHost}:${config.upstreamPort}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value == null) {
      continue;
    }
    if (['host', 'content-length', 'connection'].includes(key.toLowerCase())) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        headers.append(key, entry);
      }
    } else {
      headers.set(key, value);
    }
  }

  const response = await fetch(url, {
    method: req.method,
    headers,
    body: bodyBuffer,
    duplex: bodyBuffer ? 'half' : undefined,
  });

  res.statusCode = response.status;
  for (const [key, value] of response.headers.entries()) {
    if (key.toLowerCase() === 'content-length') {
      continue;
    }
    res.setHeader(key, value);
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  const arrayBuffer = await response.arrayBuffer();
  res.end(Buffer.from(arrayBuffer));
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Length', String(body.length));
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.end(body);
}

async function enforceRequestPolicy(bodyBuffer, req, config) {
  if (!config.policy) {
    return { ok: true };
  }

  const contentType = String(req.headers['content-type'] || '');
  const isCarRequest =
    contentType.includes('application/car') ||
    contentType.includes('application/vnd.ipld.car');
  if (!isCarRequest || req.method !== 'POST') {
    return { ok: true };
  }

  try {
    const CARTransport = await config.policy.importFromWeb('@ucanto/transport/car');
    const message = await CARTransport.request.decode({
      headers: req.headers,
      body: bodyBuffer,
    });

    for (const invocation of message.invocations ?? []) {
      const proofCids = collectProofCids(invocation.proofs ?? []);
      if (config.policy.rootDelegationCid && !proofCids.has(config.policy.rootDelegationCid)) {
        return {
          ok: false,
          status: 403,
          error: 'Invocation proof chain does not include the configured bootstrap root delegation.',
        };
      }

      for (const capability of invocation.capabilities ?? []) {
        const withValue = normalizeString(capability?.with);
        const canValue = normalizeString(capability?.can);
        if (!withValue || !canValue) {
          return {
            ok: false,
            status: 403,
            error: 'Invocation contains an incomplete capability.',
          };
        }
        if (config.policy.spaceDid && withValue !== config.policy.spaceDid) {
          return {
            ok: false,
            status: 403,
            error: `Invocation capability ${canValue} targets ${withValue}, outside configured space ${config.policy.spaceDid}.`,
          };
        }
        const allowed = config.policy.allowedCapabilities.some((entry) =>
          capabilityCovers(entry, canValue),
        );
        if (!allowed) {
          return {
            ok: false,
            status: 403,
            error: `Invocation capability ${canValue} is outside the configured bootstrap capability envelope.`,
          };
        }
      }
    }
  } catch (error) {
    return {
      ok: false,
      status: 400,
      error: `Failed to decode UCAN request: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  return { ok: true };
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    return;
  }

  const config = {
    bindHost: DEFAULT_BIND_HOST,
    bindPort: DEFAULT_BIND_PORT,
    upstreamHost: '127.0.0.1',
    upstreamPort: DEFAULT_UPSTREAM_PORT,
    policy: null,
  };

  const requireBootstrap = isTruthy(DEFAULT_REQUIRE_BOOTSTRAP);
  try {
    config.policy = await loadBootstrapPolicy({
      packageFile: DEFAULT_BOOTSTRAP_PACKAGE_FILE,
      webRoot: DEFAULT_WEB_ROOT,
    });
  } catch (error) {
    if (requireBootstrap) {
      throw error;
    }
    console.warn(
      `Bootstrap package not loaded; request guard is running in passthrough mode: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.end();
      return;
    }

    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const bodyBuffer = chunks.length > 0 ? Buffer.concat(chunks) : null;

    const policyResult = await enforceRequestPolicy(bodyBuffer, req, config);
    if (!policyResult.ok) {
      sendJson(res, policyResult.status, {
        status: 'forbidden',
        error: policyResult.error,
      });
      return;
    }

    await proxyRequest(req, res, config, bodyBuffer);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.bindPort, config.bindHost, resolve);
  });

  const shutdown = () => {
    server.close(() => {
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
