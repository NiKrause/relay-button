#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_WEB_ROOT = process.env.WEB_ROOT || '/opt/ucan-store/web';

function parseArgs(argv) {
  const args = {
    packageFile: '',
    adminDid: '',
    runtimeServiceDid: '',
    runtimeServiceOrigin: '',
    webRoot: DEFAULT_WEB_ROOT,
    summaryFile: '',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1] ?? '';
    switch (arg) {
      case '--package-file':
        args.packageFile = value;
        index += 1;
        break;
      case '--admin-did':
        args.adminDid = value;
        index += 1;
        break;
      case '--runtime-service-did':
        args.runtimeServiceDid = value;
        index += 1;
        break;
      case '--runtime-service-origin':
        args.runtimeServiceOrigin = value;
        index += 1;
        break;
      case '--web-root':
        args.webRoot = value;
        index += 1;
        break;
      case '--summary-file':
        args.summaryFile = value;
        index += 1;
        break;
      case '-h':
      case '--help':
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.packageFile) {
    throw new Error('--package-file is required');
  }

  return args;
}

function printHelp() {
  console.log(`Usage:
  ucan-store-bootstrap-verify.mjs \\
    --package-file <path> \\
    [--admin-did <did>] \\
    [--runtime-service-did <did>] \\
    [--runtime-service-origin <origin>] \\
    [--web-root <path>] \\
    [--summary-file <path>]`);
}

function normalizeString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeOrigin(value) {
  const normalized = normalizeString(value);
  if (!normalized) {
    return null;
  }
  try {
    const url = new URL(normalized);
    if (!['http:', 'https:'].includes(url.protocol)) {
      return null;
    }
    if ((url.pathname && url.pathname !== '/') || url.search || url.hash) {
      return null;
    }
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

function base64UrlToBase64(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const remainder = padded.length % 4;
  if (remainder === 0) {
    return padded;
  }
  return padded + '='.repeat(4 - remainder);
}

function decodeProofString(proof) {
  if (proof.startsWith('m')) {
    return new Uint8Array(Buffer.from(proof.slice(1), 'base64'));
  }
  if (proof.startsWith('u')) {
    return new Uint8Array(Buffer.from(base64UrlToBase64(proof.slice(1)), 'base64'));
  }
  throw new Error('Unsupported delegation proof multibase prefix');
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
          ? fileURLToPath(resolvedUrl)
          : resolvedUrl;
      } catch {
        resolved = null;
      }
    }
    if (!resolved) {
      resolved = await resolveFromWebNodeModules(webRoot, specifier);
    }
    return import(pathToFileURL(resolved).href);
  };
}

async function parseDelegation(proof, importFromWeb) {
  const bytes = decodeProofString(proof);
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
    // Fall back to Storacha proof parser.
  }

  const Proof = await importFromWeb('@storacha/client/proof');
  return withMutedConsoleLog(() => Proof.parse(proof));
}

async function verifyDelegationSignature(delegation, importFromWeb) {
  const issuerDid = delegation?.issuer?.did?.();
  if (!issuerDid) {
    return { ok: false, error: 'Delegation issuer DID is missing.' };
  }
  if (!issuerDid.startsWith('did:key:')) {
    return {
      ok: false,
      error: `Delegation issuer ${issuerDid} is not a did:key DID; bootstrap verification currently supports did:key issuers only.`,
    };
  }

  const { Verifier } = await importFromWeb('@ucanto/principal');
  const UCAN = await importFromWeb('@ipld/dag-ucan');
  const verifier = Verifier.parse(issuerDid);
  const valid = await withMutedConsoleLog(() =>
    UCAN.verifySignature(delegation.data, verifier),
  );
  return valid
    ? { ok: true }
    : { ok: false, error: `Delegation signature verification failed for issuer ${issuerDid}.` };
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const importFromWeb = buildModuleLoader(args.webRoot);
  const errors = [];
  const warnings = [];

  const raw = await fs.readFile(args.packageFile, 'utf8');
  const payload = JSON.parse(raw);
  const adminDid = normalizeString(args.adminDid) ?? normalizeString(payload.adminDid);
  const packageServiceDid = normalizeString(payload.serviceDid);
  const runtimeServiceDid = normalizeString(args.runtimeServiceDid);
  const runtimeServiceOrigin = normalizeOrigin(args.runtimeServiceOrigin);
  const allowedCapabilities = Array.isArray(payload.allowedCapabilities)
    ? payload.allowedCapabilities.map(normalizeString).filter(Boolean)
    : [];
  const spaceDid = normalizeString(payload.spaceDid);
  const proof = normalizeString(payload.rootDelegationProof);

  if (!proof) {
    throw new Error('Bootstrap package rootDelegationProof is missing.');
  }

  const delegation = await parseDelegation(proof, importFromWeb);
  const issuerDid = delegation?.issuer?.did?.() ?? null;
  const audienceDid = delegation?.audience?.did?.() ?? null;
  const capabilities = Array.isArray(delegation?.capabilities)
    ? delegation.capabilities.map((capability) => ({
        with: normalizeString(capability?.with) ?? null,
        can: normalizeString(capability?.can) ?? null,
      }))
    : [];

  if (!issuerDid) {
    errors.push('Delegation issuer DID could not be determined.');
  }
  if (!audienceDid) {
    errors.push('Delegation audience DID could not be determined.');
  }

  if (adminDid && issuerDid && adminDid !== issuerDid) {
    errors.push(`Delegation issuer ${issuerDid} does not match configured admin DID ${adminDid}.`);
  }

  const expectedAudience = runtimeServiceDid ?? packageServiceDid;
  if (expectedAudience && audienceDid && expectedAudience !== audienceDid) {
    errors.push(
      `Delegation audience ${audienceDid} does not match expected service DID ${expectedAudience}.`,
    );
  }

  if (runtimeServiceDid && packageServiceDid && runtimeServiceDid !== packageServiceDid) {
    errors.push(
      `Runtime service DID ${runtimeServiceDid} does not match bootstrap package serviceDid ${packageServiceDid}.`,
    );
  }

  const signatureCheck = await verifyDelegationSignature(delegation, importFromWeb);
  if (!signatureCheck.ok) {
    errors.push(signatureCheck.error);
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiration =
    typeof delegation?.expiration === 'number' && Number.isFinite(delegation.expiration)
      ? delegation.expiration
      : null;
  const notBefore =
    typeof delegation?.notBefore === 'number' && Number.isFinite(delegation.notBefore)
      ? delegation.notBefore
      : null;

  if (expiration !== null && expiration <= nowSeconds) {
    errors.push(`Delegation expired at ${new Date(expiration * 1000).toISOString()}.`);
  }
  if (notBefore !== null && notBefore > nowSeconds) {
    errors.push(`Delegation is not valid before ${new Date(notBefore * 1000).toISOString()}.`);
  }

  if (spaceDid) {
    const invalidScopes = capabilities.filter(
      (capability) => capability.with && capability.with !== spaceDid,
    );
    if (invalidScopes.length > 0) {
      warnings.push(
        `Delegation contains capabilities outside the configured space DID ${spaceDid}.`,
      );
    }
  }

  const missingCapabilities = [];
  for (const requiredCapability of allowedCapabilities) {
    const covered = capabilities.some(
      (capability) =>
        capability.with === spaceDid &&
        capability.can &&
        capabilityCovers(capability.can, requiredCapability),
    );
    if (!covered) {
      missingCapabilities.push(requiredCapability);
    }
  }
  if (missingCapabilities.length > 0) {
    errors.push(
      `Delegation does not cover required capabilities: ${missingCapabilities.join(', ')}.`,
    );
  }

  const packageServiceOrigin = normalizeOrigin(payload.serviceOrigin);
  if (runtimeServiceOrigin && packageServiceOrigin && runtimeServiceOrigin !== packageServiceOrigin) {
    errors.push(
      `Runtime service origin ${runtimeServiceOrigin} does not match bootstrap package serviceOrigin ${packageServiceOrigin}.`,
    );
  }

  const summary = {
    status: errors.length === 0 ? 'valid' : 'invalid',
    valid: errors.length === 0,
    errors,
    warnings,
    verification: {
      issuerDid,
      audienceDid,
      adminDid,
      packageServiceDid,
      runtimeServiceDid,
      runtimeServiceOrigin,
      packageServiceOrigin,
      spaceDid,
      signatureValid: signatureCheck.ok,
      expiration,
      notBefore,
      capabilities,
      allowedCapabilities,
      missingCapabilities,
    },
  };

  if (args.summaryFile) {
    await fs.mkdir(path.dirname(args.summaryFile), { recursive: true });
    await fs.writeFile(args.summaryFile, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  }

  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (!summary.valid) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  const summary = {
    status: 'invalid',
    valid: false,
    errors: [error instanceof Error ? error.message : String(error)],
    warnings: [],
    verification: null,
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  process.exitCode = 1;
});
