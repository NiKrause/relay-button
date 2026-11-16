import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claimText, signClaim } from './claim.mjs';
import { checkBuildRequest, createBuilder, explain, JOB_TTL_MS, MAX_JOBS, MAX_PIECE_BYTES, pieceOf, Refused, UNFETCHED_TTL_MS } from './builder.mjs';

const sha256 = 'cd'.repeat(32);
const passphrase = 'x'.repeat(44);
const cid = 'QmExampleExampleExampleExampleExampleExample12';
const vault = new Uint8Array(32).fill(7);
const other = new Uint8Array(32).fill(9);
/** A build request signed by `key`, as the app sends it. */
const req = (key = vault, sha = sha256) => ({ sha256: sha, passphrase, ...signClaim(sha, key) });

function setup(over = {}) {
	const seen = { unpacked: [], encrypted: [], removed: [] };
	let time = 1000;
	const builder = createBuilder({
		plainPath: '/plain/image.gz',
		unpack: async (from, to) => (seen.unpacked.push([from, to]), { sha256, size: 4096 }),
		encrypt: async (path, pass) => void seen.encrypted.push([path, pass]),
		cidOf: async () => cid,
		sizeOf: async () => 8192,
		remove: async (path) => void seen.removed.push(path),
		pathFor: (job) => `/work/${job}.img`,
		now: () => time,
		...over
	});
	return { builder, seen, later: (ms) => (time += ms) };
}

const refusal = (status) => (error) => error instanceof Refused && error.status === status;

test('a build request needs the image\'s hash, a long one-line passphrase and a signed claim', () => {
	const ok = req();
	assert.deepEqual(checkBuildRequest(ok), { sha256, passphrase, address: ok.address.toLowerCase() });
	const forOther = req(vault, 'ab'.repeat(32));
	for (const bad of [
		null,
		{ ...ok, sha256: undefined },
		{ ...ok, sha256: 'xyz' },
		{ ...ok, passphrase: 'short' },
		{ ...ok, passphrase: `${passphrase}\n` },
		{ ...ok, address: 'nope' }
	]) {
		assert.throws(() => checkBuildRequest(bad), refusal(400));
	}
	for (const bad of [
		{ ...ok, signature: undefined },
		{ ...ok, signature: '0x' + '00'.repeat(65) },
		{ ...ok, signature: forOther.signature },
		{ ...ok, address: req(other).address }
	]) {
		assert.throws(() => checkBuildRequest(bad), refusal(401));
	}
});

test('the claim the app signs: the same text as claimText in @le-space/sealed-image', () => {
	assert.equal(claimText(sha256, '0xAbC0000000000000000000000000000000000001'), `sealed image build\nsha256: ${sha256}\naddress: 0xabc0000000000000000000000000000000000001`);
});

test('the first signed request claims the builder; other addresses are refused', async () => {
	const { builder } = setup();
	const { done } = await builder.build(req(vault));
	await assert.rejects(builder.build(req(other)), refusal(403));
	await done;
	const again = await builder.build(req(vault));
	await again.done;
	assert.equal((await builder.status(again.job)).state, 'built');
});

test('seals the image from the volume and hands it back in pieces', async () => {
	const { builder, seen } = setup();
	assert.deepEqual(builder.info(), { service: 'sealed image builder', plain: null });
	const { job, done } = await builder.build(req());
	await assert.rejects(builder.piece(job, undefined), refusal(409));
	await done;
	assert.deepEqual(await builder.status(job), { state: 'built', cid, size: 8192 });
	assert.deepEqual(seen.unpacked, [['/plain/image.gz', `/work/${job}.img`]]);
	assert.deepEqual(seen.encrypted, [[`/work/${job}.img`, passphrase]]);
	assert.deepEqual(builder.info().plain, { sha256, size: 4096 });
	assert.deepEqual(await builder.piece(job, 'bytes=0-4095'), { path: `/work/${job}.img`, size: 8192, start: 0, end: 4095, partial: true });
	assert.deepEqual(await builder.piece(job, 'bytes=4096-99999'), { path: `/work/${job}.img`, size: 8192, start: 4096, end: 8191, partial: true });
	assert.deepEqual(await builder.forget(job), { removed: true });
	assert.deepEqual(seen.removed, [`/work/${job}.img`]);
	await assert.rejects(builder.status(job), refusal(404));
});

test('a piece is a plain byte range inside the image, of bounded size', () => {
	assert.deepEqual(pieceOf(undefined, 100), { start: 0, end: 99, partial: false });
	assert.deepEqual(pieceOf('bytes=10-19', 100), { start: 10, end: 19, partial: true });
	for (const bad of ['bytes=5-', 'bytes=-5', 'items=0-1', 'bytes=0-1,5-6', 'bytes=200-300', 'bytes=9-3']) assert.throws(() => pieceOf(bad, 100), refusal(416));
	assert.throws(() => pieceOf(`bytes=0-${MAX_PIECE_BYTES}`, 10 * MAX_PIECE_BYTES), refusal(416));
});

test('never answers with the passphrase', async () => {
	const { builder } = setup();
	const { job, done } = await builder.build(req());
	await done;
	const said = JSON.stringify([builder.info(), await builder.status(job), await builder.piece(job, 'bytes=0-1'), await builder.forget(job)]);
	assert.ok(!said.includes(passphrase));
});

test('seals nothing but the image that was asked for', async () => {
	const { builder, seen } = setup({ unpack: async () => ({ sha256: '00'.repeat(32), size: 4096 }) });
	const { job, done } = await builder.build(req());
	await done;
	assert.deepEqual(await builder.status(job), { state: 'failed', error: 'the plain image here is not the one asked for' });
	assert.equal(seen.encrypted.length, 0);
	assert.equal(seen.removed.length, 1);
});

test('builds one image at a time, holds a few jobs, and a job is known by its own id only', async () => {
	let finish;
	const gate = new Promise((resolve) => (finish = resolve));
	let building = 0;
	let most = 0;
	const { builder, seen } = setup({
		unpack: async () => {
			most = Math.max(most, ++building);
			await gate;
			building--;
			return { sha256, size: 4096 };
		}
	});
	const first = await builder.build(req());
	const more = [];
	for (let i = 1; i < MAX_JOBS; i++) more.push(await builder.build(req()));
	// While they wait: no further job, the building one cannot be removed, a waiting one can.
	await assert.rejects(builder.build(req()), refusal(503));
	await assert.rejects(builder.forget(first.job), refusal(409));
	assert.equal((await builder.status(more[0].job)).state, 'queued');
	await builder.forget(more[0].job);
	await assert.rejects(builder.status(more[0].job), refusal(404));
	finish();
	await Promise.all([first.done, ...more.map((m) => m.done)]);
	assert.equal(most, 1);
	assert.equal(seen.encrypted.length, MAX_JOBS - 1);
	assert.equal((await builder.status(first.job)).state, 'built');
	for (const call of [(id) => builder.status(id), (id) => builder.piece(id, 'bytes=0-1'), (id) => builder.forget(id)]) await assert.rejects(call('00'.repeat(24)), refusal(404));
});

test('an image nobody fetches is removed within minutes', async () => {
	const { builder, seen, later } = setup();
	const jobs = [];
	for (let i = 0; i < MAX_JOBS; i++) jobs.push(await builder.build(req()));
	await Promise.all(jobs.map((j) => j.done));
	await assert.rejects(builder.build(req()), refusal(503));
	// Asking for its state does not keep it: only fetching does.
	later(UNFETCHED_TTL_MS - 1);
	assert.equal((await builder.status(jobs[0].job)).state, 'built');
	await builder.piece(jobs[0].job, 'bytes=0-1');
	later(2);
	assert.equal((await builder.status(jobs[0].job)).state, 'built');
	await assert.rejects(builder.status(jobs[1].job), refusal(404));
	assert.equal(seen.removed.length, MAX_JOBS - 1);
	await builder.build(req());
});

test('an image being fetched stays while it is touched, and goes when it is not', async () => {
	const { builder, seen, later } = setup();
	const { job, done } = await builder.build(req());
	await done;
	await builder.piece(job, 'bytes=0-1');
	later(JOB_TTL_MS - 1);
	await builder.piece(job, 'bytes=2-3');
	later(JOB_TTL_MS - 1);
	assert.equal((await builder.status(job)).state, 'built');
	later(JOB_TTL_MS + 1);
	await assert.rejects(builder.status(job), refusal(404));
	assert.equal(seen.removed.length, 1);
});

test('failed jobs make room for new ones', async () => {
	const { builder } = setup({ unpack: async () => ({ sha256: '00'.repeat(32), size: 4096 }) });
	const jobs = [];
	for (let i = 0; i < MAX_JOBS; i++) jobs.push(await builder.build(req()));
	await Promise.all(jobs.map((j) => j.done));
	const next = await builder.build(req());
	await next.done;
	assert.equal((await builder.status(next.job)).state, 'failed');
});

test('a failed step says what lies behind it', async () => {
	const failed = new Error('unpack failed', { cause: Object.assign(new Error('no such file'), { code: 'ENOENT' }) });
	assert.equal(explain(failed), 'unpack failed: ENOENT no such file');
	const { builder } = setup({ unpack: async () => { throw failed; } });
	const { job, done } = await builder.build(req());
	await done;
	assert.deepEqual(await builder.status(job), { state: 'failed', error: 'unpack failed: ENOENT no such file' });
	// A failed job does not block the next one.
	await builder.build(req());
});

test('the claim and the size limit are the ones @le-space/sealed-image uses', async () => {
	const { readFile } = await import('node:fs/promises');
	const client = await readFile(new URL('../src/build.mjs', import.meta.url), 'utf8');
	const { CLAIM } = await import('./claim.mjs');
	assert.match(client, new RegExp(`export const CLAIM = '${CLAIM}';`));
	assert.match(client, /MAX_PLAIN_BYTES = MAX_SEALED_BYTES - SEAL_OVERHEAD_BYTES/);
	const { MAX_IMAGE_BYTES } = await import('./builder.mjs');
	assert.equal(MAX_IMAGE_BYTES, 992 * 1024 * 1024);
	// The Belege bridge's plain image (959 MiB) fits, 33 MiB under the limit.
	assert.ok(959 * 1024 * 1024 <= MAX_IMAGE_BYTES);
});
