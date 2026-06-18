import fs from 'node:fs/promises';
import path from 'node:path';
import * as Signer from '@ucanto/principal/ed25519';

const DEFAULT_SIGNER_FILE = '/var/lib/ucan-store/service-ed25519.key';
const DEFAULT_ALGORITHM = 'ed25519';

const normalizeString = (value) => (typeof value === 'string' ? value.trim() : '');

const parseUrlLike = (value) => {
  const normalized = normalizeString(value);
  if (!normalized) {
    return null;
  }

  try {
    return new URL(normalized);
  } catch {
    try {
      return new URL(`https://${normalized}`);
    } catch {
      return null;
    }
  }
};

const didWebFromUrlLike = (value) => {
  const parsed = parseUrlLike(value);
  if (!parsed || !parsed.hostname) {
    return '';
  }

  const host = parsed.hostname.toLowerCase();
  const port = parsed.port ? `%3A${parsed.port}` : '';
  return `did:web:${host}${port}`;
};

const resolveServiceDid = (env, signer) => {
  const explicitDid =
    normalizeString(env.UCAN_STORE_SERVICE_DID) ||
    normalizeString(env.PUBLIC_UPLOAD_SERVICE_DID);
  if (explicitDid) {
    return explicitDid;
  }

  const hostnameDid = didWebFromUrlLike(env.PROXY_HOSTNAME);
  if (hostnameDid) {
    return hostnameDid;
  }

  const publicUrlDid = didWebFromUrlLike(env.PUBLIC_UPLOAD_SERVICE_URL);
  if (publicUrlDid) {
    return publicUrlDid;
  }

  return signer.did();
};

const writeSignerFile = async (signerFile, signer) => {
  const parentDir = path.dirname(signerFile);
  const encoded = `${Signer.format(signer)}\n`;
  const tempFile = `${signerFile}.tmp-${process.pid}-${Date.now()}`;

  await fs.mkdir(parentDir, { recursive: true });
  await fs.writeFile(tempFile, encoded, { mode: 0o600 });
  await fs.rename(tempFile, signerFile);
};

export const loadOrCreateServiceSigner = async (env = process.env) => {
  const algorithm = normalizeString(env.UCAN_STORE_SERVICE_KEY_ALGORITHM) || DEFAULT_ALGORITHM;
  if (algorithm !== DEFAULT_ALGORITHM) {
    throw new Error(
      `Unsupported UCAN store service signer algorithm: ${algorithm}. Only ${DEFAULT_ALGORITHM} is currently supported.`
    );
  }

  const signerFile = normalizeString(env.UCAN_STORE_SERVICE_SIGNER_FILE) || DEFAULT_SIGNER_FILE;

  try {
    const existing = normalizeString(await fs.readFile(signerFile, 'utf8'));
    if (!existing) {
      throw new Error(`Service signer file is empty: ${signerFile}`);
    }
    return {
      signer: Signer.parse(existing),
      signerFile,
      algorithm,
      created: false,
    };
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }

  const signer = await Signer.generate();
  await writeSignerFile(signerFile, signer);
  return {
    signer,
    signerFile,
    algorithm,
    created: true,
  };
};

export const createServiceIdentity = async (env = process.env) => {
  const { signer, signerFile, algorithm, created } = await loadOrCreateServiceSigner(env);
  const serviceDid = resolveServiceDid(env, signer);
  return {
    signer,
    id: serviceDid === signer.did() ? signer : signer.withDID(serviceDid),
    signerFile,
    algorithm,
    created,
  };
};
