// Talking to Aleph's API from a browser or Node: reads that survive a short
// network hiccup, and a broadcast that waits until Aleph has processed the
// message. Nothing here holds a key: signing is handed in by the caller.
import { broadcastAlephMessage } from '@le-space/core';

export const ALEPH_API = 'https://api2.aleph.im';

const sleeper = (ms) => new Promise((r) => setTimeout(r, ms));

/** SHA-256 of a string, as lowercase hex (WebCrypto: browser and Node). @param {string} text */
export async function sha256Hex(text) {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** An error from this package. `code` tells errors apart whatever the language an app shows them in. */
export class AlephVmError extends Error {
	/** @param {string} message @param {string} [code] @param {Record<string, any>} [detail] */
	constructor(message, code, detail) {
		super(message);
		this.name = 'AlephVmError';
		this.code = code;
		if (detail) this.detail = detail;
	}
}

/**
 * A read from Aleph (or a node) that survives a short network hiccup: up to
 * `tries` attempts on a network error, a timeout or a 5xx, with a pause in
 * between. When all fail, the error (code `unreachable`) names the host and
 * what could not be read, instead of the browser's bare "Failed to fetch".
 * @param {string} url @param {string} [what] e.g. "asking for the balance"
 * @param {RequestInit & { tries?: number, pauseMs?: number, timeoutMs?: number, fetch?: typeof fetch, sleep?: (ms: number) => Promise<void> }} [init]
 */
export async function readFetch(url, what = 'reading', { tries = 3, pauseMs = 1500, timeoutMs = 20_000, fetch: fetchImpl = globalThis.fetch, sleep = sleeper, ...init } = {}) {
	let last = '';
	for (let i = 0; i < tries; i++) {
		if (i) await sleep(pauseMs * i);
		try {
			const res = await fetchImpl(url, { cache: 'no-store', ...init, signal: AbortSignal.timeout(timeoutMs) });
			if (res.status < 500) return res;
			last = `HTTP ${res.status}`;
		} catch (e) {
			last = e instanceof Error ? e.message : String(e);
		}
	}
	const host = new URL(url).host;
	throw new AlephVmError(`${host} could not be reached (${what}, ${tries} tries): ${last}`, 'unreachable', { host, what, tries, last });
}

/**
 * A message's status on Aleph (`processed`, `pending`, `rejected`,
 * `forgotten`, …), or null when it cannot be read or is not known.
 * @param {string} itemHash @param {{ api?: string, fetch?: typeof fetch }} [o]
 */
export async function messageStatus(itemHash, { api = ALEPH_API, fetch: fetchImpl = globalThis.fetch } = {}) {
	const res = await readFetch(`${api}/api/v0/messages/${itemHash}`, 'checking a message', { fetch: fetchImpl }).catch(() => null);
	return res?.ok ? ((await res.json().catch(() => null))?.status ?? null) : null;
}

/**
 * Broadcast `message` and wait until Aleph has processed it. The synchronous
 * broadcast may never answer when Aleph is slow, although the message was
 * processed (seen 2026-10-23); after `answerMs` it asks for its status
 * instead, and sends it again unsynchronised while Aleph does not know it.
 * @param {any} message a signed Aleph message
 * @param {{ api?: string, fetch?: typeof fetch, sleep?: (ms: number) => Promise<void>, answerMs?: number, pollMs?: number, waitMs?: number }} [o]
 * @returns {Promise<{ httpStatus: number, response: any }>}
 */
export async function broadcast(message, { api = ALEPH_API, fetch: fetchImpl = globalThis.fetch, sleep = sleeper, answerMs = 60_000, pollMs = 5_000, waitMs = 15 * 60_000 } = {}) {
	const timed = (u, i) => fetchImpl(u, { ...i, signal: AbortSignal.timeout(answerMs) });
	try {
		return await broadcastAlephMessage(message, { apiHost: api, sync: true, attempts: 1, fetch: timed });
	} catch (e) {
		if (!['TimeoutError', 'AbortError', 'TypeError'].includes(/** @type {any} */ (e)?.name)) throw e;
	}
	const until = Date.now() + waitMs;
	while (Date.now() < until) {
		const res = await fetchImpl(`${api}/api/v0/messages/${message.item_hash}`, { cache: 'no-store' }).catch(() => null);
		const status = res?.ok ? (await res.json().catch(() => null))?.status : null;
		if (status === 'processed') return { httpStatus: 200, response: { message_status: status } };
		if (status === 'rejected' || status === 'forgotten') return { httpStatus: 422, response: { message_status: status } };
		// Not known yet (404): the broadcast may not have arrived; send it again, unsynchronised.
		if (res?.status === 404) await broadcastAlephMessage(message, { apiHost: api, sync: false, fetch: timed }).catch(() => null);
		await sleep(pollMs);
	}
	throw new AlephVmError(`Aleph did not process the ${message.type} within ${Math.round(waitMs / 60_000)} minutes`, 'not-processed');
}

/**
 * A `post(message)` that broadcasts, waits, and throws (code `refused`, with
 * `detail.status`) when Aleph does not take the message.
 * @param {Parameters<typeof broadcast>[1]} [o]
 * @returns {(message: any) => Promise<any>}
 */
export function poster(o) {
	return async (message) => {
		const { httpStatus, response } = await broadcast(message, o);
		if (httpStatus >= 300) throw new AlephVmError(`Aleph refused the ${message.type} (${httpStatus}): ${JSON.stringify(response).slice(0, 200)}`, 'refused', { status: httpStatus, response });
		return response;
	};
}
