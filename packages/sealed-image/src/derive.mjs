// The passphrase of a private image, derived from a root key the caller holds
// (an app's master secret): HKDF-SHA256 with no salt, the info
// `<label>/<plain image SHA-256>`, 32 bytes, as base64url without padding
// (43 characters). One passphrase per root key, app label and plain image,
// so a new plain image gets a new passphrase and no two apps share one.
//
// WebCrypto only: the same in a browser and in Node. Paperless anywhere's
// label is `paperless-anywhere/image-passphrase/v1`.

const HEX64 = /^[0-9a-f]{64}$/;
const LABEL = /^[\x21-\x7e]{1,200}$/;

/** @param {Uint8Array} bytes */
const base64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * @param {Uint8Array} root 32 bytes, kept by the caller
 * @param {{ label: string, plainSha256: string }} o `label`: one per app and purpose, e.g. `belege/bridge-image-passphrase/v1`
 * @returns {Promise<string>}
 */
export async function derivePassphrase(root, { label, plainSha256 }) {
	if (!(root instanceof Uint8Array) || root.length !== 32) throw new Error('the root key must be 32 bytes');
	if (!LABEL.test(label ?? '')) throw new Error('the label: printable ASCII without spaces');
	if (!HEX64.test(plainSha256 ?? '')) throw new Error('the plain image is named by its SHA-256 (64 hex)');
	const key = await crypto.subtle.importKey('raw', root, 'HKDF', false, ['deriveBits']);
	const info = new TextEncoder().encode(`${label}/${plainSha256}`);
	const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info }, key, 256);
	return base64url(new Uint8Array(bits));
}
