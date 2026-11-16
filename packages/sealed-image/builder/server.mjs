// Starts the image builder on 127.0.0.1:8080, where Aleph's attestation agent
// forwards what arrives on the VM's attested TLS port. See builder.mjs.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';
import { importer } from 'ipfs-unixfs-importer';
import { createBuilder, handler } from './builder.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const work = process.env.BUILDER_WORK || '/work';
// The plain image, gzipped, on the verified volume (builder/vprogram).
const plainPath = process.env.BUILDER_PLAIN || '/plain/plain.img.gz';
await mkdir(work, { recursive: true, mode: 0o700 });

/**
 * Unpacks the gzipped plain image into `to` and says what it is. The limit
 * and the SHA-256 are those of the unpacked image, which is what gets sealed.
 */
async function unpack(from, to, max) {
	const hash = createHash('sha256');
	let size = 0;
	const measure = new Transform({
		transform(part, _encoding, done) {
			size += part.length;
			if (size > max) return done(new Error('the plain image is larger than Aleph takes in one upload'));
			hash.update(part);
			done(null, part);
		}
	});
	await pipeline([createReadStream(from), createGunzip(), measure, createWriteStream(to, { mode: 0o600 })]);
	return { sha256: hash.digest('hex'), size };
}

/** The passphrase reaches cryptsetup on stdin only: no file, no argument, no environment. */
function encrypt(path, passphrase) {
	return new Promise((resolve, reject) => {
		const child = spawn(join(here, 'encrypt-image.sh'), [path], { stdio: ['pipe', 'ignore', 'inherit'] });
		child.on('error', reject);
		child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('the encryption failed'))));
		child.stdin.end(passphrase);
	});
}

/** `ipfs add` defaults, which is the CID Aleph's node makes and compares when the caller stores the image. */
async function cidOf(path) {
	const sink = { put: async (cid) => cid, get: async () => { throw new Error('no blocks kept'); }, has: async () => false };
	let last;
	for await (const entry of importer([{ content: createReadStream(path) }], sink, { cidVersion: 0, rawLeaves: false, reduceSingleLeafToSelf: true })) last = entry;
	return last.cid.toString();
}

const builder = createBuilder({
	plainPath,
	unpack,
	encrypt,
	cidOf,
	sizeOf: async (path) => (await stat(path)).size,
	remove: (path) => rm(path, { force: true }),
	pathFor: (job) => join(work, `${job}.img`)
});

createServer(handler(builder, (path, start, end) => createReadStream(path, { start, end }))).listen(8080, '127.0.0.1', () => console.log('image builder on 127.0.0.1:8080'));
