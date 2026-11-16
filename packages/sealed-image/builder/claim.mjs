// Who a builder works for. A builder is started for one build, and anyone
// who can reach it could send it jobs, so the first job whose request is
// signed claims it: from then on it takes jobs only from that address. The
// app signs with its own key (an Ethereum personal_sign, EIP-191) and, if
// another address claimed the builder first, starts another one.
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';

export const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
export const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;

/** What the app signs for a build of the plain image `sha256`. Never the passphrase. */
// The same text as claimText in @le-space/sealed-image (src/build.mjs, CLAIM).
// It names no app: the SHA-256 names the plain image, and so the builder.
export const CLAIM = 'sealed image build';
export const claimText = (sha256, address) => `${CLAIM}\nsha256: ${sha256}\naddress: ${address.toLowerCase()}`;

/** The hash an Ethereum wallet signs for `text` (EIP-191 version 0x45). */
function personalHash(text) {
	const message = utf8ToBytes(text);
	return keccak_256(concatBytes(utf8ToBytes(`\x19Ethereum Signed Message:\n${message.length}`), message));
}

const addressOf = (publicKey) => `0x${bytesToHex(keccak_256(publicKey.slice(1)).slice(-20))}`;

/** The address that signed `text`, lowercase, or null. @param {string} text @param {string} signature 0x + r, s, v */
export function signerOf(text, signature) {
	if (!SIGNATURE.test(signature)) return null;
	try {
		const bytes = hexToBytes(signature.slice(2));
		const v = bytes[64];
		const recovery = v >= 27 ? v - 27 : v;
		if (recovery !== 0 && recovery !== 1) return null;
		const sig = secp256k1.Signature.fromCompact(bytes.slice(0, 64)).addRecoveryBit(recovery);
		return addressOf(sig.recoverPublicKey(personalHash(text)).toRawBytes(false));
	} catch {
		return null;
	}
}

/** Signs as a wallet would, for the container check and the trial run. @param {Uint8Array} [key] */
export function signClaim(sha256, key = secp256k1.utils.randomPrivateKey()) {
	const address = addressOf(secp256k1.getPublicKey(key, false));
	const sig = secp256k1.sign(personalHash(claimText(sha256, address)), key);
	return { address, signature: `0x${sig.toCompactHex()}${(27 + sig.recovery).toString(16)}` };
}
