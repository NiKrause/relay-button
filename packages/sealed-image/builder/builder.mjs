// The sealed image builder: gives a person an encrypted copy of one public
// plain image (Paperless anywhere's, the Belege bridge's, …), sealed with a
// passphrase only their app knows (@le-space/sealed-image).
//
// It runs measured, as an Aleph V-PROGRAM (vprogram/README.md): the app checks
// the attestation first, so it knows this code is what receives the
// passphrase. A V-PROGRAM is a closed box. Its guest firewall lets nothing in
// but the attested port, replies to outbound connections included, so the
// builder fetches nothing and uploads nothing:
//
// - the plain image comes on a verified volume, whose dm-verity root hash is
//   on the measured boot line: which image gets sealed is part of what the
//   app attests;
// - the sealed image goes back to the caller over the attested channel, in
//   pieces, and the caller stores it on Aleph itself.
//
//   GET    /                    → {service, plain: {sha256, size} | null}
//   POST   /build               {sha256, passphrase, address, signature} → 202 {job}
//   GET    /job/<job>           → {state, cid?, size?, error?}
//   GET    /job/<job>/image     the sealed image; `Range: bytes=a-b` for a piece
//   DELETE /job/<job>           removes it
//
// The first signed build request claims the builder for its address
// (claim.mjs); jobs from any other address are refused (403).
//
// The builder keeps nothing: a few jobs at most (MAX_JOBS), built one after
// the other, the passphrase goes to cryptsetup's stdin and nowhere else, and
// a job's image is removed when the caller says so, when nobody fetched it
// within minutes of being built, or when nobody touched it for a while.
import { randomBytes } from 'node:crypto';
import { ADDRESS, claimText, signerOf } from './claim.mjs';

const HEX64 = /^[0-9a-f]{64}$/;
// Aleph takes 1 GiB in one upload, and sealing adds 32 MiB (encrypt-image.sh):
// a plain image of up to 992 MiB, unpacked. The Belege bridge's (959 MiB) and
// Paperless anywhere's (836 MiB) fit. @le-space/sealed-image's MAX_PLAIN_BYTES.
export const MAX_IMAGE_BYTES = 1024 * 1024 * 1024 - 32 * 1024 * 1024;
/** What `GET /` says the builder is; the publish workflow looks for it. */
export const SERVICE = 'sealed image builder';
// A built image nobody has fetched a piece of is removed after this long:
// the app asks every few seconds and starts fetching at once.
export const UNFETCHED_TTL_MS = 5 * 60 * 1000;
// Counted from the last time the caller touched the job: fetching a whole
// image through a relay takes a while, but every piece touches it.
export const JOB_TTL_MS = 10 * 60 * 1000;
// Jobs held at once, the one building included; further requests wait for
// one to end. Each holds up to one image on the builder's disk.
export const MAX_JOBS = 3;
export const MAX_PIECE_BYTES = 16 * 1024 * 1024;
const MAX_BODY = 16 * 1024;

export class Refused extends Error {
	/** @param {number} status @param {string} message */
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}

/** An error with what lies behind it (Node keeps the reason in `cause`). Nothing here comes from the caller. */
export function explain(error) {
	const parts = [];
	for (let e = error, depth = 0; e && depth < 4; e = e.cause, depth++) {
		const text = [e.code, e.message].filter(Boolean).join(' ');
		if (text && !parts.includes(text)) parts.push(text);
	}
	return (parts.join(': ') || String(error)).slice(0, 300);
}

/** What a build request must look like. */
export function checkBuildRequest(body) {
	if (!body || typeof body !== 'object') throw new Refused(400, 'expected a JSON object');
	const { sha256, passphrase, address, signature } = body;
	if (!HEX64.test(sha256 ?? '')) throw new Refused(400, 'sha256: the SHA-256 of the plain image (64 hex)');
	if (typeof passphrase !== 'string' || passphrase.length < 32 || passphrase.length > 256 || /[\r\n\0]/.test(passphrase)) {
		throw new Refused(400, 'passphrase: 32 to 256 characters, one line');
	}
	if (typeof address !== 'string' || !ADDRESS.test(address)) throw new Refused(400, 'address: the signing address (0x + 40 hex)');
	const signer = typeof signature === 'string' ? signerOf(claimText(sha256, address), signature) : null;
	if (!signer || signer !== address.toLowerCase()) throw new Refused(401, 'signature: a personal_sign of the build claim by address');
	return { sha256, passphrase, address: signer };
}

/**
 * The piece of a file of `size` bytes a `Range` header asks for: `bytes=a-b`
 * only, inside the file, at most MAX_PIECE_BYTES. No header means the whole.
 * @param {string | undefined} header @param {number} size
 * @returns {{ start: number, end: number, partial: boolean }} `end` inclusive
 */
export function pieceOf(header, size) {
	if (header === undefined) return { start: 0, end: size - 1, partial: false };
	const m = /^bytes=(\d{1,12})-(\d{1,12})$/.exec(header);
	if (!m) throw new Refused(416, 'Range: bytes=<first>-<last>');
	const start = Number(m[1]);
	const end = Math.min(Number(m[2]), size - 1);
	if (start > end) throw new Refused(416, 'the range lies outside the image');
	if (end - start + 1 > MAX_PIECE_BYTES) throw new Refused(416, `a piece has at most ${MAX_PIECE_BYTES} bytes`);
	return { start, end, partial: true };
}

/**
 * @param {{
 *   plainPath: string,
 *   unpack: (from: string, to: string, max: number) => Promise<{ sha256: string, size: number }>,
 *   encrypt: (path: string, passphrase: string) => Promise<void>,
 *   cidOf: (path: string) => Promise<string>,
 *   sizeOf: (path: string) => Promise<number>,
 *   remove: (path: string) => Promise<void>,
 *   pathFor: (job: string) => string,
 *   now?: () => number
 * }} deps
 */
export function createBuilder(deps) {
	const now = deps.now ?? Date.now;
	/** @type {Map<string, { id: string, state: string, path: string, touched: number, built?: number, fetched?: boolean, cid?: string, size?: number, error?: string }>} */
	const jobs = new Map();
	/** What the plain image on the volume is, known after the first build. @type {null | { sha256: string, size: number }} */
	let plain = null;
	/** The builds, one after the other. */
	let line = Promise.resolve();
	/** The address the first signed request came from; null until then. @type {string | null} */
	let owner = null;

	const drop = async (j) => {
		if (jobs.get(j.id) !== j) return;
		jobs.delete(j.id);
		j.state = 'removed';
		await deps.remove(j.path).catch(() => {});
	};
	const stale = (j, t) =>
		(j.state === 'built' && !j.fetched && t - /** @type {number} */ (j.built) > UNFETCHED_TTL_MS) ||
		((j.state === 'built' || j.state === 'failed') && t - j.touched > JOB_TTL_MS);
	const expire = async () => {
		const t = now();
		for (const j of [...jobs.values()]) if (stale(j, t)) await drop(j);
	};
	const view = (j) => ({ state: j.state, ...(j.cid ? { cid: j.cid, size: j.size } : {}), ...(j.error ? { error: j.error } : {}) });
	const mine = (id) => {
		const j = jobs.get(id);
		if (!j) throw new Refused(404, 'no such job');
		j.touched = now();
		return j;
	};

	async function run(j, sha256, passphrase) {
		if (j.state !== 'queued') return; // forgotten while it waited
		j.state = 'building';
		try {
			const got = await deps.unpack(deps.plainPath, j.path, MAX_IMAGE_BYTES);
			plain = got;
			// The caller says which image it expects; nothing else is ever sealed for it.
			if (got.sha256 !== sha256) throw new Error('the plain image here is not the one asked for');
			await deps.encrypt(j.path, passphrase);
			j.cid = await deps.cidOf(j.path);
			j.size = await deps.sizeOf(j.path);
			j.state = 'built';
			j.built = now();
		} catch (error) {
			j.error = explain(error);
			j.state = 'failed';
			await deps.remove(j.path).catch(() => {});
		}
		j.touched = now();
	}

	return {
		info() {
			return { service: SERVICE, plain };
		},
		async build(body) {
			await expire();
			const { sha256, passphrase, address } = checkBuildRequest(body);
			if (owner && owner !== address) throw new Refused(403, 'claimed by another address; start another builder');
			owner = address;
			// A failed job holds no image: it makes room first.
			if (jobs.size >= MAX_JOBS) for (const j of [...jobs.values()]) if (j.state === 'failed' && jobs.size >= MAX_JOBS) await drop(j);
			if (jobs.size >= MAX_JOBS) throw new Refused(503, 'busy with other images; try again in a few minutes');
			const id = randomBytes(24).toString('hex');
			const j = { id, state: 'queued', path: deps.pathFor(id), touched: now() };
			jobs.set(id, j);
			const done = (line = line.then(() => run(j, sha256, passphrase)));
			return { job: id, done };
		},
		async status(id) {
			await expire();
			return view(mine(id));
		},
		/** Where a piece of the sealed image lies: `{ path, start, end, size, partial }`. */
		async piece(id, range) {
			await expire();
			const j = mine(id);
			if (j.state !== 'built') throw new Refused(409, `the image is ${j.state}`);
			const at = pieceOf(range, /** @type {number} */ (j.size));
			j.fetched = true;
			return { path: j.path, size: /** @type {number} */ (j.size), ...at };
		},
		async forget(id) {
			await expire();
			const j = mine(id);
			if (j.state === 'building') throw new Refused(409, 'the image is being built');
			await drop(j);
			return { removed: true };
		}
	};
}

/**
 * The HTTP face: JSON in, JSON out, a small body limit, and the image as
 * bytes. `readPiece(path, start, end)` gives a stream of that piece.
 */
export function handler(builder, readPiece) {
	return async (req, res) => {
		const send = (status, body) => {
			res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
			res.end(JSON.stringify(body));
		};
		try {
			const path = new URL(req.url, 'http://builder').pathname;
			const read = async () => {
				let size = 0;
				const parts = [];
				for await (const part of req) {
					size += part.length;
					if (size > MAX_BODY) throw new Refused(413, 'the request is too large');
					parts.push(part);
				}
				try {
					return JSON.parse(Buffer.concat(parts).toString('utf8'));
				} catch {
					throw new Refused(400, 'expected JSON');
				}
			};
			const at = /^\/job\/([0-9a-f]{48})(\/image)?$/.exec(path);
			if (req.method === 'GET' && path === '/') return send(200, builder.info());
			if (req.method === 'POST' && path === '/build') return send(202, { job: (await builder.build(await read())).job });
			if (req.method === 'GET' && at && !at[2]) return send(200, await builder.status(at[1]));
			if (req.method === 'DELETE' && at && !at[2]) return send(200, await builder.forget(at[1]));
			if (req.method === 'GET' && at?.[2]) {
				const piece = await builder.piece(at[1], req.headers.range);
				res.writeHead(piece.partial ? 206 : 200, {
					'content-type': 'application/octet-stream',
					'content-length': piece.end - piece.start + 1,
					'cache-control': 'no-store',
					...(piece.partial ? { 'content-range': `bytes ${piece.start}-${piece.end}/${piece.size}` } : {})
				});
				const stream = readPiece(piece.path, piece.start, piece.end);
				stream.on('error', () => res.destroy());
				return stream.pipe(res);
			}
			throw new Refused(404, 'no such route');
		} catch (error) {
			if (error instanceof Refused) return send(error.status, { error: error.message });
			send(500, { error: 'the builder failed' });
		}
	};
}
