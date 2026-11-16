import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AlephVmError, broadcast, readFetch } from '../src/aleph.mjs';

const message = { type: 'AGGREGATE', item_hash: 'a'.repeat(64) };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
// The synchronous broadcast never answers; only the abort signal ends it.
// AbortSignal.timeout does not keep Node's event loop alive, so a timer does.
const hang = (_url, init) =>
	new Promise((_resolve, reject) => {
		const alive = setTimeout(() => {}, 10_000);
		init.signal.addEventListener('abort', () => (clearTimeout(alive), reject(init.signal.reason)));
	});

describe('broadcast', () => {
	it('returns the answer of the synchronous broadcast', async () => {
		const fetch = async () => json({ message_status: 'processed', publication_status: { status: 'success' } });
		assert.equal((await broadcast(message, { fetch })).httpStatus, 200);
	});

	it('asks for the status when the synchronous broadcast does not answer', async () => {
		const fetch = async (url, init) => (String(url).endsWith(`/messages/${message.item_hash}`) ? json({ status: 'processed' }) : hang(url, init));
		assert.deepEqual(await broadcast(message, { fetch, answerMs: 20, pollMs: 1 }), { httpStatus: 200, response: { message_status: 'processed' } });
	});

	it('reports a rejected message as refused', async () => {
		const fetch = async (url, init) => (String(url).includes('/messages/') ? json({ status: 'rejected' }) : hang(url, init));
		assert.equal((await broadcast(message, { fetch, answerMs: 20, pollMs: 1 })).httpStatus, 422);
	});

	it('gives up after waiting', async () => {
		const fetch = async (url, init) => (String(url).includes('/messages/') ? json({ status: 'pending' }) : hang(url, init));
		await assert.rejects(broadcast(message, { fetch, answerMs: 20, pollMs: 1, waitMs: 50 }), /did not process/);
	});
});

describe('readFetch', () => {
	const url = 'https://api2.aleph.im/api/v0/addresses/0x1/balance';
	it('tries again after a network error and a 5xx', async () => {
		const answers = [() => Promise.reject(new TypeError('Failed to fetch')), () => Promise.resolve(json({}, 502)), () => Promise.resolve(json({ credit_balance: 7 }))];
		let i = 0;
		const res = await readFetch(url, 'reading the balance', { pauseMs: 1, fetch: () => answers[i++]() });
		assert.deepEqual(await res.json(), { credit_balance: 7 });
		assert.equal(i, 3);
	});
	it('passes a 4xx through at once', async () => {
		let i = 0;
		const res = await readFetch(url, 'x', { pauseMs: 1, fetch: async () => (i++, json({}, 404)) });
		assert.equal(res.status, 404);
		assert.equal(i, 1);
	});
	it('names what could not be read when every try fails, with a code an app can translate', async () => {
		await assert.rejects(readFetch(url, 'reading the balance', { pauseMs: 1, fetch: () => Promise.reject(new TypeError('Failed to fetch')) }), (error) => {
			assert.ok(error instanceof AlephVmError);
			assert.equal(error.code, 'unreachable');
			assert.deepEqual(error.detail, { host: 'api2.aleph.im', what: 'reading the balance', tries: 3, last: 'Failed to fetch' });
			return true;
		});
	});
});
