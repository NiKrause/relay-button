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
const DEFAULT_ADMIN_API_TOKEN = process.env.UCAN_STORE_ADMIN_API_TOKEN || '';
const DEFAULT_SERVICE_SIGNER_FILE =
  process.env.UCAN_STORE_SERVICE_SIGNER_FILE || '/var/lib/ucan-store/service-ed25519.key';
const DEFAULT_SERVICE_DID =
  process.env.UCAN_STORE_SERVICE_DID || process.env.PUBLIC_UPLOAD_SERVICE_DID || '';
const DEFAULT_UPLOAD_SERVICE_URL =
  process.env.PUBLIC_UPLOAD_SERVICE_URL || '';
const DEFAULT_REVOCATION_URL =
  process.env.PUBLIC_REVOCATION_URL || '';
const DEFAULT_RECEIPTS_URL =
  process.env.PUBLIC_RECEIPTS_URL || '';
const PROTOCOL_CAPABILITIES = new Set(['ucan/conclude', 'filecoin/offer']);

function printHelp() {
  console.log(`Usage:
  ucan-store-request-guard.mjs

Environment:
  UCAN_STORE_PROXY_HOST            Bind host (default: 127.0.0.1)
  UCAN_STORE_PROXY_PORT            Bind port (default: 8788)
  STORACHA_LOCAL_PORT              Upstream upload-service port (default: 8787)
  UCAN_STORE_BOOTSTRAP_PACKAGE_FILE  Bootstrap package path
  UCAN_STORE_REQUIRE_BOOTSTRAP_PACKAGE  Enforce bootstrap package presence (default: 1)
  UCAN_STORE_ADMIN_API_TOKEN       Bearer token for /admin/delegations
  UCAN_STORE_SERVICE_SIGNER_FILE   Persisted service signer path
  UCAN_STORE_SERVICE_DID           Explicit service DID alias for delegated proofs
  PUBLIC_UPLOAD_SERVICE_URL        Public service origin for discovery manifest
  PUBLIC_REVOCATION_URL            Public revocation endpoint for discovery manifest
  PUBLIC_RECEIPTS_URL              Public receipts endpoint for discovery manifest`);
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

function isProtocolCapability(capability) {
  return PROTOCOL_CAPABILITIES.has(capability);
}

function isTruthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function base64ToBytes(value) {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

function bytesToBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

function bytesToBase64Url(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function didStringFromPrincipal(principal) {
  if (!principal) {
    return null;
  }
  if (typeof principal.did === 'function') {
    return principal.did();
  }
  return normalizeString(principal.did || principal);
}

async function readJsonBody(req, bodyBuffer) {
  if (!bodyBuffer || bodyBuffer.length === 0) {
    return {};
  }
  try {
    const payload = JSON.parse(bodyBuffer.toString('utf8'));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('JSON body must be an object.');
    }
    return payload;
  } catch (error) {
    throw new Error(
      `Invalid JSON body: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
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

async function loadServiceSigner(config) {
  const signerFile = normalizeString(config.serviceSignerFile);
  if (!signerFile) {
    throw new Error('UCAN_STORE_SERVICE_SIGNER_FILE is not configured.');
  }

  const { parse } = await config.policy.importFromWeb('@ucanto/principal/ed25519');
  const raw = await fs.readFile(signerFile, 'utf8');
  const signer = parse(raw.trim());
  const configuredServiceDid = normalizeString(config.serviceDid);
  return configuredServiceDid ? signer.withDID(configuredServiceDid) : signer;
}

function resolveRequestedCapabilities(payload, config) {
  const requested = Array.isArray(payload.capabilities)
    ? payload.capabilities.map(normalizeString).filter(Boolean)
    : [];
  const requestedCapabilities =
    requested.length > 0 ? requested : [...(config.policy.allowedCapabilities ?? [])];

  if (requestedCapabilities.length === 0) {
    throw new Error('No capabilities were requested and no bootstrap default exists.');
  }

  for (const capability of requestedCapabilities) {
    const allowed = config.policy.allowedCapabilities.some((entry) =>
      capabilityCovers(entry, capability),
    );
    if (!allowed) {
      throw new Error(
        `Requested capability ${capability} is outside the configured bootstrap capability envelope.`,
      );
    }
  }

  return requestedCapabilities;
}

function resolveRequestedExpiration(payload, config) {
  const defaultSeconds = Number.isInteger(config.policy.package.defaultUserDelegationExpiration)
    ? config.policy.package.defaultUserDelegationExpiration
    : null;
  const maxSeconds = Number.isInteger(config.policy.package.maxUserDelegationExpiration)
    ? config.policy.package.maxUserDelegationExpiration
    : null;

  let requestedSeconds = null;
  if (payload.expirationSeconds === null) {
    requestedSeconds = null;
  } else if (Number.isInteger(payload.expirationSeconds) && payload.expirationSeconds >= 0) {
    requestedSeconds = payload.expirationSeconds;
  } else if (
    typeof payload.expirationHours === 'number' &&
    Number.isFinite(payload.expirationHours) &&
    payload.expirationHours >= 0
  ) {
    requestedSeconds = Math.floor(payload.expirationHours * 60 * 60);
  } else if (payload.expirationSeconds !== undefined || payload.expirationHours !== undefined) {
    throw new Error('expirationSeconds must be null or a non-negative integer.');
  } else {
    requestedSeconds = defaultSeconds;
  }

  if (requestedSeconds === null && maxSeconds !== null) {
    throw new Error(
      'An unbounded delegation expiration is not allowed when maxUserDelegationExpiration is configured.',
    );
  }

  if (requestedSeconds !== null && maxSeconds !== null && requestedSeconds > maxSeconds) {
    throw new Error(
      `Requested expiration ${requestedSeconds}s exceeds configured maxUserDelegationExpiration ${maxSeconds}s.`,
    );
  }

  return requestedSeconds;
}

async function createDelegationExport(config, bodyBuffer, req) {
  if (!config.policy) {
    throw new Error('Bootstrap policy is unavailable; delegation issuance is disabled.');
  }

  const authHeader = normalizeString(req.headers.authorization);
  const bearerPrefix = 'Bearer ';
  const expectedToken = normalizeString(config.adminApiToken);
  if (!expectedToken) {
    return {
      status: 503,
      payload: {
        status: 'disabled',
        error:
          'UCAN_STORE_ADMIN_API_TOKEN is not configured; admin delegation issuance is disabled.',
      },
    };
  }
  if (!authHeader || !authHeader.startsWith(bearerPrefix) || authHeader.slice(bearerPrefix.length) !== expectedToken) {
    return {
      status: 401,
      payload: {
        status: 'unauthorized',
        error: 'Missing or invalid admin bearer token.',
      },
    };
  }

  const payload = await readJsonBody(req, bodyBuffer);
  const targetDid =
    normalizeString(payload.targetDid) || normalizeString(payload.audienceDid) || null;
  if (!targetDid || !targetDid.startsWith('did:')) {
    throw new Error('targetDid must be a non-empty DID string.');
  }

  const capabilities = resolveRequestedCapabilities(payload, config);
  const expirationSeconds = resolveRequestedExpiration(payload, config);
  const { Verifier } = await config.policy.importFromWeb('@ucanto/principal');
  const { delegate } = await config.policy.importFromWeb('@ucanto/core/delegation');

  const serviceSigner = await loadServiceSigner(config);
  const audience = Verifier.parse(targetDid);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiration =
    expirationSeconds === null ? undefined : nowSeconds + expirationSeconds;

  const delegation = await delegate({
    issuer: serviceSigner,
    audience,
    capabilities: capabilities.map((can) => ({
      with: config.policy.spaceDid,
      can,
    })),
    expiration,
    proofs: [config.policy.delegation],
    facts: [],
  });

  const archiveResult = await delegation.archive();
  const carBytes =
    archiveResult instanceof Uint8Array
      ? archiveResult
      : archiveResult && typeof archiveResult === 'object' && archiveResult.ok instanceof Uint8Array
        ? archiveResult.ok
        : null;
  if (!carBytes || carBytes.length === 0) {
    throw new Error('Failed to archive delegated proof.');
  }

  const proofBase64 = bytesToBase64(carBytes);
  const proofBase64Url = bytesToBase64Url(carBytes);
  const proof = `m${proofBase64}`;
  const expiresAt = typeof expiration === 'number' ? new Date(expiration * 1000).toISOString() : null;
  const proofCids = Array.from(collectProofCids([delegation]));

  return {
    status: 200,
    payload: {
      status: 'ok',
      delegation: {
        cid: delegation.cid?.toString?.() ?? null,
        issuerDid: didStringFromPrincipal(serviceSigner),
        audienceDid: targetDid,
        spaceDid: config.policy.spaceDid,
        capabilities,
        proof,
        proofFormat: 'ucan-car-multibase-base64',
        proofBase64,
        proofBase64Url,
        proofChainCids: proofCids,
        expiresAt,
        expiresInSeconds: expirationSeconds,
        importHint: 'Paste the `proof` value into the ucan-store UI import form.',
      },
    },
  };
}

function buildServiceManifest(config) {
  if (!config.policy) {
    return {
      status: 'unconfigured',
      error: 'Bootstrap policy is unavailable.',
    };
  }

  const serviceOrigin =
    normalizeString(config.publicUploadServiceUrl) ||
    normalizeString(config.policy.package.serviceOrigin) ||
    null;
  const revocationUrl =
    normalizeString(config.publicRevocationUrl) ||
    serviceOrigin ||
    null;
  const receiptsUrl =
    normalizeString(config.publicReceiptsUrl) ||
    (serviceOrigin ? `${serviceOrigin.replace(/\/$/, '')}/receipt/` : null);

  return {
    kind: 'ucan-store-service-manifest',
    version: 1,
    serviceDid: normalizeString(config.serviceDid) || null,
    serviceOrigin,
    didDocument: serviceOrigin ? `${serviceOrigin.replace(/\/$/, '')}/.well-known/did.json` : null,
    pwaOrigin: normalizeString(config.policy.package.pwaOrigin) || null,
    spaceDid: config.policy.spaceDid,
    allowedCapabilities: [...(config.policy.allowedCapabilities ?? [])],
    revocationUrl,
    receiptsUrl,
    bootstrapPolicy: {
      defaultUserDelegationExpiration:
        config.policy.package.defaultUserDelegationExpiration ?? null,
      maxUserDelegationExpiration:
        config.policy.package.maxUserDelegationExpiration ?? null,
    },
    delegationIssuance: {
      enabled: Boolean(normalizeString(config.adminApiToken)),
      endpoint: '/admin/delegations',
      policyEndpoint: '/admin/delegations/policy',
      proofFormat: 'ucan-car-multibase-base64',
    },
    discovery: {
      manifestPath: '/.well-known/ucan-store.json',
      aliases: ['/service-manifest.json'],
      binding: 'domain-first',
    },
  };
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Amz-Checksum-Sha256');
  const arrayBuffer = await response.arrayBuffer();
  res.end(Buffer.from(arrayBuffer));
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Length', String(body.length));
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Amz-Checksum-Sha256');
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
      const capabilities = invocation.capabilities ?? [];
      const isProtocolInvocation =
        capabilities.length > 0 &&
        capabilities.every((capability) => isProtocolCapability(normalizeString(capability?.can)));
      if (isProtocolInvocation) {
        continue;
      }

      const proofCids = collectProofCids(invocation.proofs ?? []);
      if (config.policy.rootDelegationCid && !proofCids.has(config.policy.rootDelegationCid)) {
        return {
          ok: false,
          status: 403,
          error: 'Invocation proof chain does not include the configured bootstrap root delegation.',
        };
      }

      for (const capability of capabilities) {
        const withValue = normalizeString(capability?.with);
        const canValue = normalizeString(capability?.can);
        if (isProtocolCapability(canValue)) {
          continue;
        }
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
    adminApiToken: DEFAULT_ADMIN_API_TOKEN,
    serviceSignerFile: DEFAULT_SERVICE_SIGNER_FILE,
    serviceDid: DEFAULT_SERVICE_DID,
    publicUploadServiceUrl: DEFAULT_UPLOAD_SERVICE_URL,
    publicRevocationUrl: DEFAULT_REVOCATION_URL,
    publicReceiptsUrl: DEFAULT_RECEIPTS_URL,
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
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Amz-Checksum-Sha256');
      res.end();
      return;
    }

    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const bodyBuffer = chunks.length > 0 ? Buffer.concat(chunks) : null;

    if (req.method === 'POST' && req.url === '/admin/delegations') {
      try {
        const result = await createDelegationExport(config, bodyBuffer, req);
        sendJson(res, result.status, result.payload);
      } catch (error) {
        sendJson(res, 400, {
          status: 'invalid_request',
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (req.method === 'GET' && req.url === '/admin/delegations/policy') {
      const expectedToken = normalizeString(config.adminApiToken);
      const authHeader = normalizeString(req.headers.authorization);
      const authorized =
        expectedToken &&
        authHeader &&
        authHeader.startsWith('Bearer ') &&
        authHeader.slice('Bearer '.length) === expectedToken;
      if (!authorized) {
        sendJson(res, 401, {
          status: 'unauthorized',
          error: 'Missing or invalid admin bearer token.',
        });
        return;
      }

      sendJson(res, 200, {
        status: 'ok',
        policy: {
          serviceDid: normalizeString(config.serviceDid),
          spaceDid: config.policy?.spaceDid ?? null,
          allowedCapabilities: config.policy?.allowedCapabilities ?? [],
          defaultUserDelegationExpiration:
            config.policy?.package?.defaultUserDelegationExpiration ?? null,
          maxUserDelegationExpiration:
            config.policy?.package?.maxUserDelegationExpiration ?? null,
          endpoint: '/admin/delegations',
          proofFormat: 'ucan-car-multibase-base64',
        },
      });
      return;
    }

    if (
      req.method === 'GET' &&
      (req.url === '/.well-known/ucan-store.json' || req.url === '/service-manifest.json')
    ) {
      sendJson(res, 200, {
        status: 'ok',
        manifest: buildServiceManifest(config),
      });
      return;
    }

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
