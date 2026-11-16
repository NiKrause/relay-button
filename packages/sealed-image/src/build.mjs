// A sealed image of one's own: a measured builder (the V-PROGRAM in
// ../builder) holds one public plain image on a verified volume and seals a
// copy of it with a passphrase the caller derived (derive.mjs). The caller
// attests the builder first, sends the passphrase over that attested channel
// once, fetches the sealed image back in runs (each over a connection
// attested anew, because an attest relay carries only so much per
// connection), stores it on Aleph itself under its own address, and waits
// until Aleph confirms the STORE.
//
// Nothing here holds app texts: errors carry a `code` (SealedImageError),
// progress is reported as `{ step, data }`, and the app words both.
import { ALEPH_API, callJson, checkTemplate, messageStatus, refusedAttestation, runOnFreshVProgram, sha256Hex, signAsDelegate } from '@le-space/aleph-vm';

const HEX64 = /^[0-9a-f]{64}$/;
const CID = /^[A-Za-z0-9]{40,64}$/;
const sleeper = (ms) => new Promise((r) => setTimeout(r, ms));

/** @typedef {import('@le-space/aleph-vm').AppKey} AppKey */
/** @typedef {import('@le-space/aleph-vm').Channel} Channel */
/**
 * The builder an app trusts, and the plain image it asks for.
 *
 * `measurements` and `policy` are what the attestation must show; `route` is
 * how an attest relay reaches a running builder; `plain` names the public
 * image the builder holds by its SHA-256 (the builder refuses to seal any
 * other), where it lies on Aleph (`store`) and the commit it was built from;
 * `vprogram` is a running builder's V-PROGRAM on Aleph. `claim` is the first
 * line of the text the build request is signed with; it must be the one the
 * builder was published with (`sealed image build` for builders from this
 * repository).
 *
 * Or, with `program` (the V-PROGRAM content of a published builder) and `crn`
 * (the node that runs V-PROGRAMs), no builder runs between builds: each build
 * starts one from that content and forgets it afterwards (buildOnFreshBuilder).
 * @typedef {{ route?: string, program?: Record<string, any>, crn?: string, measurements: string[], policy: number | string, vprogram?: string, claim?: string, plain: { sha256: string, store?: string, commit?: string } }} Builder
 */

/** What builders published from this repository sign build requests with (builder/claim.mjs). */
export const CLAIM = 'sealed image build';

/**
 * The largest sealed image: Aleph takes 1 GiB in one upload. The builder adds
 * 32 MiB (the LUKS2 header and room to grow), so a plain image may have
 * MAX_PLAIN_BYTES at most (builder/builder.mjs refuses a larger one).
 */
export const MAX_SEALED_BYTES = 1024 * 1024 * 1024;
export const SEAL_OVERHEAD_BYTES = 32 * 1024 * 1024;
export const MAX_PLAIN_BYTES = MAX_SEALED_BYTES - SEAL_OVERHEAD_BYTES;

export class SealedImageError extends Error {
	/** @param {string} message @param {string} code what failed, for code that must tell errors apart whatever the language @param {Record<string, any>} [detail] */
	constructor(message, code, detail) {
		super(message);
		this.name = 'SealedImageError';
		this.code = code;
		if (detail) this.detail = detail;
	}
}

/**
 * What the caller signs (personal_sign) with a build request: the first signed
 * request claims the builder for its address (builder/claim.mjs, claimText:
 * the two must stay the same). Never the passphrase.
 * @param {string} sha256 @param {string} address @param {string} [claim]
 */
export const claimText = (sha256, address, claim = CLAIM) => `${claim}\nsha256: ${sha256}\naddress: ${address.toLowerCase()}`;

/** A builder entry that is complete, or an error (`no-builder`, `no-plain`) that says what is missing. @template {Builder} B @param {B} builder @returns {B} */
export function checkBuilder(builder) {
	// A running builder has a route; one started for each build has its
	// V-PROGRAM content and the node, and gets its route when it starts.
	const reachable = Boolean(builder?.route) || (Boolean(builder?.program?.verification) && HEX64.test(builder?.crn ?? ''));
	if (!reachable || !builder.measurements?.length || builder.policy == null) throw new SealedImageError('no builder: a route, or V-PROGRAM content and node, with measurements and policy', 'no-builder');
	if (!HEX64.test(builder.plain?.sha256 ?? '')) throw new SealedImageError('the builder names no plain image (its SHA-256)', 'no-plain');
	return builder;
}

/**
 * The STORE message for the sealed image `cid`, owned and paid by `payer`
 * (the app's own address by default), signed by the app's key.
 * @param {AppKey} app @param {string} cid
 * @param {{ channel: string, time?: number, payer?: string }} o
 */
export async function storeMessage(app, cid, { channel, time = Date.now() / 1000, payer = app.address }) {
	if (!CID.test(cid)) throw new SealedImageError('not a content address', 'bad-cid');
	const item_content = JSON.stringify({ address: payer, time, item_type: 'ipfs', item_hash: cid, payment: { type: 'credit' } });
	// Sent by the app's key, in the payer's name (the payer authorized the key).
	return signAsDelegate({ sender: payer, chain: 'ETH', type: 'STORE', item_hash: await sha256Hex(item_content), item_type: 'inline', item_content, time, channel }, app);
}

/** The host of an API URL, for showing. @param {string} url */
const apiHost = (url) => {
	try {
		return new URL(url).host;
	} catch {
		return '';
	}
};

/**
 * Stores `image` on Aleph beside its signed STORE `message`, and says which
 * content address the node made.
 * @param {Blob} image @param {any} message @param {string} [api] @param {{ fetch?: typeof fetch }} [o]
 * @returns {Promise<{ status: number, cid: string | null, reason: string }>}
 */
export async function storeOnAleph(image, message, api = ALEPH_API, { fetch: fetchImpl = globalThis.fetch } = {}) {
	const form = new FormData();
	form.append('file', image, 'rootfs');
	form.append('metadata', JSON.stringify({ message, sync: true }));
	const response = await fetchImpl(`${api}/api/v0/ipfs/add_file`, { method: 'POST', body: form });
	const text = await response.text().catch(() => '');
	let answer = null;
	try {
		answer = JSON.parse(text);
	} catch {
		/* not JSON: kept as the reason below */
	}
	const reason = response.ok ? '' : String(answer?.error ?? answer?.message ?? text).replace(/\s+/g, ' ').slice(0, 300);
	return { status: response.status, cid: answer?.hash ?? null, reason };
}

/**
 * The sealed image comes back in pieces of this size, each one request over
 * an attested channel. The channel collects an answer by joining what
 * arrives, so its cost grows with the square of the piece: a quarter MiB
 * keeps that small and still needs few round trips.
 */
export const PIECE_BYTES = 256 * 1024;
/**
 * What one run asks for. A relay that lets an image builder carry more per
 * connection (relay-button#230: 256 MiB, 10 minutes) brings a run over one
 * connection, attested once. A relay with the default limits (4 MiB, 120 s)
 * closes it earlier; the run then goes on from its last piece over a new
 * connection at once.
 */
export const RUN_BYTES = 32 * 1024 * 1024;
/**
 * Connections side by side. A relay allows one client four at a time, and a
 * closed one counts until the relay has seen it close: three leave room for
 * that, and for the next run's connection while the last one closes.
 */
export const LANES = 3;
/**
 * How often a run may fail in a row, without a single piece coming back,
 * before the fetch gives up. A try that brings pieces starts the count anew,
 * and the next try goes on where the last one broke off.
 */
export const RUN_TRIES = 10;
/** The longest wait between two tries of a run. */
export const RETRY_MAX_MS = 30_000;
/** Where the sealed image is uploaded, try by try: Aleph's API, then another node, then the first again. */
export const UPLOAD_HOSTS = [ALEPH_API, 'https://api3.aleph.im', ALEPH_API];

/** An error that ends a fetch: a refused attestation, or one of this package's that is not "unreachable". */
const final = (error) => refusedAttestation(error) || (error instanceof SealedImageError && error.code !== 'unreachable');

/**
 * The sealed image of `job`, `size` bytes, as a Blob: in runs of `runBytes`,
 * each over a fresh channel from `open` and in pieces of `pieceBytes`, up to
 * `lanes` runs at a time. A run that breaks off goes on where it stopped; a
 * job the builder no longer has, or a builder that fails its attestation,
 * ends it.
 * @param {{ open: () => Promise<Channel>, job: string, size: number, pieceBytes?: number, runBytes?: number, lanes?: number, runTries?: number, sleep?: (ms: number) => Promise<void>, retryMs?: number, onBytes?: (n: number) => void }} a
 */
export async function fetchSealed({ open, job, size, pieceBytes = PIECE_BYTES, runBytes = RUN_BYTES, lanes = LANES, runTries = RUN_TRIES, sleep = sleeper, retryMs = 2000, onBytes = () => {} }) {
	const runs = [];
	for (let start = 0; start < size; start += runBytes) runs.push({ start, end: Math.min(start + runBytes, size) });
	const parts = new Array(runs.length);
	let next = 0;
	let failed = null;

	const fetchRun = async (run) => {
		let last = '';
		const pieces = [];
		let at = run.start;
		for (let failures = 0; failures < runTries && !failed; ) {
			if (failures) await sleep(Math.min(retryMs * failures, RETRY_MAX_MS));
			let channel = null;
			const before = at;
			try {
				channel = await open();
				for (; at < run.end; ) {
					const end = Math.min(at + pieceBytes, run.end) - 1;
					const piece = await channel.request('GET', `/job/${job}/image`, { headers: { range: `bytes=${at}-${end}` } });
					if ([404, 409, 410, 416].includes(piece.status)) throw new SealedImageError(`the builder no longer has the image (${piece.status})`, 'image-gone', { status: piece.status });
					if (piece.status !== 206 || piece.body.length !== end - at + 1) throw new Error(String(piece.status));
					pieces.push(piece.body);
					at = end + 1;
					onBytes(piece.body.length);
				}
				return pieces;
			} catch (error) {
				// The image gone, or an attestation refused: trying again cannot help.
				// A builder or relay not answering for a moment can.
				if (final(error)) throw error;
				last = error instanceof Error ? error.message : String(error);
				// Pieces came back: a relay's limit or a short break, not a dead
				// line. Go on at once; only tries without any piece wait and count.
				failures = at > before ? 0 : failures + 1;
			} finally {
				channel?.close();
			}
		}
		throw new SealedImageError(`a piece of the image did not arrive: ${last.slice(0, 120)}`, 'piece-missing', { last: last.slice(0, 120) });
	};
	const lane = async () => {
		while (!failed && next < runs.length) {
			const index = next++;
			try {
				parts[index] = await fetchRun(runs[index]);
			} catch (error) {
				failed ??= error;
			}
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, Math.min(lanes, runs.length)) }, lane));
	if (failed) throw failed;
	return new Blob(parts.flat(), { type: 'application/octet-stream' });
}

/**
 * An image that was fetched but is not confirmed on Aleph yet, kept while the
 * page is open: a second try uploads it again instead of building and
 * fetching it again. It holds nothing readable without the passphrase.
 * @typedef {{ current: null | { key: string, cid: string, size: number, image: Blob, attested: null | { measurement: string, at: string }, message?: any } }} Kept
 */
/** @type {Kept} */
export const keptInThisPage = { current: null };

/** The key a kept image is held under: one per address and plain image. @param {string} address @param {string} sha256 */
export const keptKey = (address, sha256) => `${address.toLowerCase()}/${sha256}`;

/** Aleph's word on the STORE: processed, or an error. */
async function awaitStore(itemHash, { read, sleep, tries, delayMs }) {
	for (let i = 0; i < tries; i++) {
		const status = await read(itemHash);
		if (status === 'processed') return;
		if (status === 'rejected' || status === 'forgotten') throw new SealedImageError(`Aleph did not take the STORE (${status})`, 'store-rejected', { status });
		await sleep(delayMs);
	}
	throw new SealedImageError('Aleph has not confirmed the STORE yet', 'store-pending');
}

/**
 * @typedef {{
 *   step: 'start' | 'attest' | 'build' | 'fetch' | 'sign' | 'upload' | 'confirm',
 *   data?: Record<string, any>
 * }} Progress
 */

/**
 * Has `builder` seal its plain image with `passphrase`, fetches the sealed
 * image, stores it on Aleph as a STORE of `payer` (sent by the app's key) and
 * waits for Aleph to confirm it. Returns
 * `{ storeHash, cid, size, plainSha256, builtAt, attested }`; the passphrase
 * stays with the caller.
 *
 * `open` resolves to an attested channel to the builder (and must reject
 * unless the attestation shows the builder's measurement). It is called for
 * the build, where the passphrase goes through it, and again for every run of
 * the sealed image that comes back; a channel may say which measurement the
 * hardware reported (`measurement`), which is returned as `attested`.
 * @param {{
 *   passphrase: string, app: AppKey, payer?: string, channel: string, builder: Builder,
 *   open: () => Promise<Channel>,
 *   onProgress?: (p: Progress) => void,
 *   store?: typeof storeOnAleph,
 *   read?: (itemHash: string) => Promise<string | null>,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 *   kept?: Kept,
 *   pollMs?: number, buildTries?: number, confirmTries?: number, pieceBytes?: number, runBytes?: number, lanes?: number, runTries?: number, retryMs?: number
 * }} a
 */
export async function buildSealedImage({ passphrase, app, payer = app.address, channel: alephChannel, builder, open, onProgress = () => {}, store = storeOnAleph, read = (h) => messageStatus(h), sleep = sleeper, now = Date.now, kept = keptInThisPage, pollMs = 5000, buildTries = 240, confirmTries = 180, pieceBytes = PIECE_BYTES, runBytes = RUN_BYTES, lanes = LANES, runTries = RUN_TRIES, retryMs = 2000 }) {
	const { plain } = checkBuilder(builder);
	if (typeof passphrase !== 'string' || passphrase.length < 32 || passphrase.length > 256 || /[\r\n\0]/.test(passphrase)) throw new SealedImageError('the passphrase must be one line of 32 to 256 characters', 'bad-passphrase');
	const key = keptKey(app.address, plain.sha256);
	if (kept.current?.key !== key) kept.current = null;

	if (!kept.current) kept.current = await sealAndFetch();
	const { cid, size, image, attested } = kept.current;

	// A STORE that was signed and uploaded before is only waited for again.
	let message = kept.current.message;
	if (!message) {
		onProgress({ step: 'sign', data: { cid } });
		message = await storeMessage(app, cid, { channel: alephChannel, time: now() / 1000, payer });
		onProgress({ step: 'sign', data: { cid, storeHash: message.item_hash } });
		const stored = await uploadWithRetries(image, message, size);
		if (stored.status >= 300) throw new SealedImageError(`Aleph did not take the image (${stored.status})${stored.reason ? `: ${stored.reason}` : ''}`, 'upload-refused', { status: stored.status, reason: stored.reason });
		// The node names the content address it made from what it received.
		if (stored.cid && stored.cid !== cid) {
			kept.current = null;
			throw new SealedImageError('Aleph stored another image than the builder sealed', 'other-image', { cid: stored.cid });
		}
		kept.current.message = message;
	}

	onProgress({ step: 'confirm', data: { storeHash: message.item_hash } });
	try {
		await awaitStore(message.item_hash, { read, sleep, tries: confirmTries, delayMs: pollMs });
		onProgress({ step: 'confirm', data: { storeHash: message.item_hash, processed: true } });
	} catch (error) {
		// Refused: the next try signs and uploads anew. Not confirmed yet: it waits again.
		if (error instanceof SealedImageError && error.code === 'store-rejected') delete kept.current.message;
		throw error;
	}
	kept.current = null;
	return {
		storeHash: String(message.item_hash),
		cid,
		size,
		plainSha256: plain.sha256,
		builtAt: new Date(now()).toISOString(),
		attested: attested ? { vprogram: builder.vprogram ?? null, measurement: attested.measurement, at: attested.at } : null
	};

	/**
	 * Upload the sealed image, more than once if the connection breaks: one
	 * request of up to 1 GiB, which an unsteady line can lose. Before trying
	 * again it asks Aleph whether the STORE arrived after all; the second try
	 * goes to another API node. Only a gateway that gave up (502, 503, 504) is
	 * tried again; any other answer is final.
	 */
	async function uploadWithRetries(image, message, size) {
		let last = null;
		for (let attempt = 0; attempt < UPLOAD_HOSTS.length; attempt++) {
			const host = UPLOAD_HOSTS[attempt];
			if (attempt) {
				await sleep(Math.min(retryMs * 5 * attempt, RETRY_MAX_MS));
				const status = await read(message.item_hash).catch(() => null);
				if (status === 'processed' || status === 'pending') return { status: 200, cid: null, reason: '' };
			}
			onProgress({ step: 'upload', data: { size, host: apiHost(host), attempt: attempt + 1 } });
			try {
				const stored = await store(image, message, host);
				if (![502, 503, 504].includes(stored.status)) return stored;
				last = stored;
			} catch (error) {
				last = { status: 0, cid: null, reason: String(error instanceof Error ? error.message : error).slice(0, 200) };
			}
		}
		if (last?.status) return last;
		throw new SealedImageError(`the upload broke off ${UPLOAD_HOSTS.length} times: ${last?.reason ?? ''}`, 'upload-broken', { reason: last?.reason ?? '' });
	}

	/** Has the builder seal the image and fetches it; the builder drops it afterwards, whatever happened. */
	async function sealAndFetch() {
		onProgress({ step: 'attest', data: {} });
		let opened = 0;
		const counted = async () => {
			const c = await open();
			opened++;
			return c;
		};
		let channel = await counted();
		const attested = typeof channel.measurement === 'string' && channel.measurement ? { measurement: channel.measurement, at: new Date(now()).toISOString() } : null;
		onProgress({ step: 'attest', data: { relay: channel.relay ?? null, measurement: attested?.measurement ?? null } });
		let job = '';
		try {
			onProgress({ step: 'build', data: { plainSha256: plain.sha256 } });
			// Sent once, over the channel that was just attested, and never again.
			// Signed by the app's key: the first signed request claims the builder.
			const signature = await app.signMessage({ message: claimText(plain.sha256, app.address, builder.claim) });
			const started = await callJson(channel, 'POST', '/build', { sha256: plain.sha256, passphrase, address: app.address, signature });
			const said = started.answer?.error ? String(started.answer.error).slice(0, 200) : '';
			if (started.status === 503 && /busy/i.test(said)) throw new SealedImageError('the builder is busy with other images', 'busy');
			if (started.status === 403 && /claimed/i.test(said)) throw new SealedImageError('another address claimed the builder', 'claimed');
			job = started.answer?.job ?? '';
			if (started.status !== 202 || !/^[0-9a-f]{48}$/.test(job)) throw new SealedImageError(`the builder did not accept the build (${started.status})${said ? `: ${said}` : ''}`, 'not-accepted', { status: started.status, error: said });

			// A relay ends a connection after a while: asking goes on over a new one.
			let built = null;
			let drops = 0;
			for (let i = 0; i < buildTries && !built; i++) {
				await sleep(pollMs);
				let state;
				try {
					channel ??= await counted();
					state = await callJson(channel, 'GET', `/job/${job}`);
				} catch (error) {
					channel?.close();
					channel = null;
					if (refusedAttestation(error)) throw error;
					if (++drops > 5) throw new SealedImageError('the connection to the builder broke off again and again', 'dropped');
					continue;
				}
				drops = 0;
				if (state.status !== 200) throw new SealedImageError(`the builder does not know the build (${state.status})`, 'job-unknown', { status: state.status });
				if (state.answer?.state === 'failed') throw new SealedImageError(`the build failed${state.answer.error ? `: ${String(state.answer.error).slice(0, 200)}` : ''}`, 'build-failed', { error: state.answer.error ? String(state.answer.error).slice(0, 200) : '' });
				if (state.answer?.state === 'built') built = state.answer;
			}
			if (!built) throw new SealedImageError('the build took too long', 'build-slow');
			const size = Number(built.size);
			if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_SEALED_BYTES) throw new SealedImageError('the builder named no valid size', 'bad-size');
			if (!CID.test(built.cid ?? '')) throw new SealedImageError('the builder named no valid content address', 'bad-cid');
			onProgress({ step: 'build', data: { plainSha256: plain.sha256, cid: built.cid, size } });
			channel?.close();
			channel = null;

			// The sealed image holds nothing readable without the passphrase, and
			// every run of it arrives over a channel attested like the first.
			let got = 0;
			const shown = () => onProgress({ step: 'fetch', data: { got, size, lanes, attested: opened } });
			shown();
			const image = await fetchSealed({ open: counted, job, size, pieceBytes, runBytes, lanes, runTries, sleep, retryMs, onBytes: (n) => { got += n; shown(); } });
			return { key, cid: built.cid, size, image, attested };
		} finally {
			channel?.close();
			// Whatever happened: the builder need not keep this image. Tried a few
			// times: an image left behind takes one of the builder's few jobs
			// until it expires (minutes; builder/builder.mjs).
			for (let attempt = 0; job && attempt < 4; attempt++) {
				if (attempt) await sleep(retryMs * attempt);
				let last = null;
				try {
					last = await open();
					const dropped = await callJson(last, 'DELETE', `/job/${job}`);
					if (dropped.status === 200 || dropped.status === 404) job = '';
				} catch {
					/* tried again; at worst the builder removes it after ten minutes */
				} finally {
					last?.close();
				}
			}
		}
	}
}

/**
 * Build on a builder started for this build, and forget that builder
 * afterwards, whatever happened (@le-space/aleph-vm's runOnFreshVProgram).
 * The caller notes the builder between start and forget (`onStarted`,
 * `onForgotten`), so a closed window leaves nothing running for longer than
 * the next opening. An image already fetched in this page (an upload that
 * failed) needs no builder: it is only uploaded again. If another address
 * claimed the builder first, it is forgotten and one more is started, once.
 * @param {Omit<Parameters<typeof buildSealedImage>[0], 'open'> & {
 *   builder: Builder & { program: Record<string, any>, crn: string },
 *   opener: (running: Builder & { route: string, vprogram: string }) => () => Promise<Channel>,
 *   onStarted?: (vprogram: string) => Promise<void> | void,
 *   onForgotten?: (vprogram: string) => Promise<void> | void,
 *   post?: (message: any) => Promise<any>,
 *   upTries?: number, upMs?: number
 * }} a
 */
export async function buildOnFreshBuilder(a) {
	for (let attempt = 0; ; attempt++) {
		try {
			return await buildOnOneBuilder(a);
		} catch (error) {
			if (!(error instanceof SealedImageError && error.code === 'claimed') || attempt >= 1) throw error;
		}
	}
}

/** One builder, started, used and forgotten. @param {Parameters<typeof buildOnFreshBuilder>[0]} a */
async function buildOnOneBuilder({ builder, opener, onStarted, onForgotten, post, upTries, upMs, ...rest }) {
	const { app, payer = app.address, channel, onProgress = () => {}, sleep = sleeper, kept = keptInThisPage } = rest;
	checkBuilder(builder);
	checkTemplate(/** @type {any} */ (builder));
	if (kept.current?.key === keptKey(app.address, builder.plain.sha256)) {
		return buildSealedImage({ ...rest, builder, open: () => Promise.reject(new SealedImageError('no builder needed: the image is only uploaded again', 'no-builder')) });
	}
	return runOnFreshVProgram({
		app,
		template: /** @type {any} */ (builder),
		channel,
		payer,
		opener: /** @type {any} */ (opener),
		onStarted,
		onForgotten,
		onProgress: (p) => onProgress(/** @type {Progress} */ (p)),
		...(post ? { post } : {}),
		sleep,
		...(upTries ? { upTries } : {}),
		...(upMs !== undefined ? { upMs } : {}),
		reason: 'sealed image built',
		work: ({ open, running }) => buildSealedImage({ ...rest, builder: /** @type {Builder} */ (running), open })
	});
}

// Aleph starts a V-PROGRAM only when its payer holds a day of everything it
// then pays for: the builder and what already runs (min_runtime_days: 1).
// Measured 2026-11-14: the builder (6 GiB, 2 vCPUs) 23.75 credits a second,
// the STORE of a sealed image (868 MiB) 0.045 a second; used when Aleph's
// price estimate cannot be asked.
export const BUILDER_CREDITS_PER_HOUR = 85_500;
export const IMAGE_STORE_CREDITS_PER_HOUR = 170;

/**
 * The credits a payer must hold for Aleph to start a builder: a day of the
 * builder, of the sealed image's storage and of what it already spends.
 * @param {{ builderPerHour?: number | null, storePerHour?: number, spendingPerHour?: number }} [o]
 */
export const creditsForBuild = ({ builderPerHour, storePerHour = IMAGE_STORE_CREDITS_PER_HOUR, spendingPerHour = 0 } = {}) => Math.ceil(((builderPerHour ?? BUILDER_CREDITS_PER_HOUR) + storePerHour + spendingPerHour) * 24);
