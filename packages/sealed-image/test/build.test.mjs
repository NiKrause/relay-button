import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { privateKeyToAccount } from 'viem/accounts';
import { recoverMessageAddress } from 'viem';
import { AlephVmError, attestedOpener, relayHost, sha256Hex } from '@le-space/aleph-vm';
import { expect } from './expect.mjs';
import { CLAIM, LANES, MAX_PLAIN_BYTES, MAX_SEALED_BYTES, PIECE_BYTES, RUN_BYTES, SealedImageError, buildOnFreshBuilder, buildSealedImage, checkBuilder, claimText, creditsForBuild, BUILDER_CREDITS_PER_HOUR, IMAGE_STORE_CREDITS_PER_HOUR, derivePassphrase, storeMessage } from '../src/index.mjs';

const channel = 'example-app';
const passphrase = await derivePassphrase(new Uint8Array(32).fill(7), { label: 'example/image-passphrase/v1', plainSha256: 'ef'.repeat(32) });
const app = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const builder = { route: '?builder=example', measurements: ['ab'.repeat(48)], policy: 0x30000, plain: { sha256: 'ef'.repeat(32) } };
const job = '0a'.repeat(24);
const cid = 'QmExampleExampleExampleExampleExampleExample12';
const encoder = new TextEncoder();
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

const image = new Uint8Array(2500).map((_, n) => n % 251);

/** A builder that answers as builder/builder.mjs does, and notes what it was sent. */
function fakeBuilder(over = {}) {
	const seen = { calls: [], closed: false };
	let polls = 0;
	const answer = (status, body) => ({ status, body: encoder.encode(JSON.stringify(body)) });
	const channel = {
		close: () => void (seen.closed = true),
		request: async (method, path, init = {}) => {
			const body = init.body ? JSON.parse(init.body) : undefined;
			seen.calls.push({ method, path, body, ...(init.headers?.range ? { range: init.headers.range } : {}) });
			if (over[`${method} ${path}`]) return over[`${method} ${path}`](init);
			if (method === 'GET' && path === '/') return answer(200, { service: 'sealed image builder', plain: builder.plain });
			if (method === 'POST' && path === '/build') return answer(202, { job });
			if (method === 'GET' && path === `/job/${job}`) return answer(200, ++polls < 2 ? { state: 'building' } : { state: 'built', cid, size: image.length });
			if (method === 'GET' && path === `/job/${job}/image`) {
				const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec(init.headers.range);
				return { status: 206, body: image.slice(Number(a), Number(b) + 1) };
			}
			if (method === 'DELETE' && path === `/job/${job}`) return answer(200, { removed: true });
			return answer(404, { error: 'no such route' });
		}
	};
	return { seen, answer, open: async () => channel };
}

/** Aleph's upload, noting what arrived. */
function fakeStore(result = {}) {
	const got = { bytes: null, message: null };
	const store = async (blob, message) => {
		got.bytes = new Uint8Array(await blob.arrayBuffer());
		got.message = message;
		return { status: 200, cid, ...result };
	};
	return { got, store };
}

// `kept` is what a second try finds of the first; each call here starts with nothing.
const quick = () => ({ sleep: async () => {}, read: async () => 'processed', now: () => 1_800_000_000_000, pieceBytes: 1000, kept: { current: null } });


describe('a sealed image of one\'s own', () => {
	it('signs a STORE message for the built file, as the app\'s own address', async () => {
		const message = await storeMessage(app, cid, { channel, time: 1_800_000_000 });
		const content = JSON.parse(message.item_content);
		expect(content).toEqual({ address: app.address, time: 1_800_000_000, item_type: 'ipfs', item_hash: cid, payment: { type: 'credit' } });
		expect(message.item_hash).toBe(await sha256Hex(message.item_content));
		expect(await recoverMessageAddress({ message: ['ETH', app.address, 'STORE', message.item_hash].join('\n'), signature: message.signature })).toBe(app.address);
		await expect(storeMessage(app, '../etc', { channel })).rejects.toThrow({ code: 'bad-cid' });
	});

	it('has it sealed, fetches it in pieces, stores it itself and returns what the profile keeps', async () => {
		const { seen, open } = fakeBuilder();
		const { got, store } = fakeStore();
		const steps = [];
		const result = await buildSealedImage({ passphrase, app, channel, builder, open, store, onProgress: (p) => steps.push(p.step), ...quick() });
		expect([...new Set(steps)]).toEqual(['attest', 'build', 'fetch', 'sign', 'upload', 'confirm']);
		const { signature, ...sentBody } = seen.calls[0].body;
		expect(seen.calls[0]).toMatchObject({ method: 'POST', path: '/build' });
		expect(sentBody).toEqual({ sha256: builder.plain.sha256, passphrase: passphrase, address: app.address });
		// Signed by the app's key; the signed text holds no passphrase.
		const claim = claimText(builder.plain.sha256, app.address);
		expect(claim).toBe(`${CLAIM}\nsha256: ${builder.plain.sha256}\naddress: ${app.address.toLowerCase()}`);
		expect(claim).not.toContain(passphrase);
		expect(await recoverMessageAddress({ message: claim, signature })).toBe(app.address);
		expect(seen.calls.filter((c) => c.range).map((c) => c.range)).toEqual(['bytes=0-999', 'bytes=1000-1999', 'bytes=2000-2499']);
		// What goes to Aleph is exactly what the builder handed back, beside a STORE for its content address.
		expect(got.bytes).toEqual(image);
		expect(JSON.parse(got.message.item_content).item_hash).toBe(cid);
		expect(result).toEqual({ storeHash: got.message.item_hash, cid, size: image.length, plainSha256: builder.plain.sha256, builtAt: '2027-01-15T08:00:00.000Z', attested: null });
		// The builder is told to drop the image, and the channel is closed.
		expect(seen.calls.at(-1)).toMatchObject({ method: 'DELETE', path: `/job/${job}` });
		expect(seen.closed).toBe(true);
	});

	it('sends the passphrase to nothing but an attested builder', async () => {
		const { seen, open } = fakeBuilder();
		const { got, store } = fakeStore();
		await expect(buildSealedImage({ passphrase, app, channel, builder, open: async () => { throw new Error('measurement mismatch'); }, store, ...quick() })).rejects.toThrow('measurement mismatch');
		expect(seen.calls).toEqual([]);
		expect(got.message).toBeNull();
		// And only in the one build request: not to Aleph, not in any other call.
		await buildSealedImage({ passphrase, app, channel, builder, open, store, ...quick() });
		const pass = passphrase;
		expect(seen.calls.filter((c) => JSON.stringify(c).includes(pass)).map((c) => c.path)).toEqual(['/build']);
		expect(JSON.stringify(got.message)).not.toContain(pass);
	});

	it('says so when the builder is busy, the build fails or a piece is missing, and has the image dropped', async () => {
		const run = (over) => {
			const base = fakeBuilder();
			const fake = fakeBuilder(Object.fromEntries(Object.entries(over).map(([k, v]) => [k, () => (Array.isArray(v) ? base.answer(...v) : v)])));
			return { promise: buildSealedImage({ passphrase, app, channel, builder, open: fake.open, store: fakeStore().store, ...quick() }), seen: fake.seen };
		};
		const busy = run({ 'POST /build': [503, { error: 'busy' }] });
		await expect(busy.promise).rejects.toThrow({ code: 'busy' });
		expect(busy.seen.closed).toBe(true);
		// No job was given, so there is nothing to drop.
		expect(busy.seen.calls.some((c) => c.method === 'DELETE')).toBe(false);
		await expect(run({ [`GET /job/${job}`]: [200, { state: 'failed', error: 'the plain image here is not the one asked for' }] }).promise).rejects.toThrow({ code: 'build-failed', detail: { error: 'the plain image here is not the one asked for' } });
		const short = run({ [`GET /job/${job}/image`]: { status: 206, body: new Uint8Array(3) } });
		await expect(short.promise).rejects.toThrow({ code: 'piece-missing' });
		expect(short.seen.calls.at(-1)).toMatchObject({ method: 'DELETE' });
		await expect(run({ [`GET /job/${job}`]: [200, { state: 'built', cid, size: 5 * 1024 ** 3 }] }).promise).rejects.toThrow({ code: 'bad-size' });
	});

	it('keeps nothing when Aleph does not take the image', async () => {
		const { open } = fakeBuilder();
		await expect(buildSealedImage({ passphrase, app, channel, builder, open, store: async () => ({ status: 500, cid: null }), ...quick() })).rejects.toThrow({ code: 'upload-refused', detail: { status: 500 } });
		await expect(buildSealedImage({ passphrase, app, channel, builder, open, store: fakeStore({ cid: 'QmAnotherFileAnotherFileAnotherFileAnotherFile1' }).store, ...quick() })).rejects.toThrow({ code: 'other-image' });
		await expect(buildSealedImage({ passphrase, app, channel, builder, open, store: fakeStore().store, ...quick(), read: async () => 'rejected' })).rejects.toThrow({ code: 'store-rejected' });
		await expect(buildSealedImage({ passphrase, app, channel, builder, open, store: fakeStore().store, ...quick(), read: async () => null, confirmTries: 3 })).rejects.toThrow({ code: 'store-pending' });
	});

	/**
	 * A builder behind an attest relay as it is deployed: a connection carries
	 * at most `maxBytes` down, and one client may hold `maxOpen` at a time.
	 * `breakAt` lists connections (by number, from 1) that die at their first image piece.
	 */
	function relayedBuilder(big, { maxBytes = RELAY_BYTES / SCALE, maxOpen = 4, breakAt = [], refuseAt = 0, gone = false, unreachableAt = [], dropFails = 0 } = {}) {
		const seen = { opened: 0, open: 0, mostOpen: 0, builds: 0, deleted: 0, polls: 0 };
		const answer = (status, body) => ({ status, body: encoder.encode(JSON.stringify(body)) });
		const open = async () => {
			const number = ++seen.opened;
			if (number === refuseAt) throw new Error('measurement mismatch');
			if (unreachableAt.includes(number)) throw new AlephVmError('not reachable just now', 'unreachable');
			if (seen.open >= maxOpen) throw new Error('connection to the relay closed: 429');
			seen.open++;
			seen.mostOpen = Math.max(seen.mostOpen, seen.open);
			let down = 0;
			let closed = false;
			const close = () => {
				if (!closed) seen.open--;
				closed = true;
			};
			return {
				measurement: 'ab'.repeat(48),
				close,
				request: async (method, path, init = {}) => {
					await Promise.resolve();
					if (closed) throw new Error('the connection closed while waiting for the answer');
					if (method === 'POST' && path === '/build') return ++seen.builds, answer(202, { job });
					if (method === 'GET' && path === `/job/${job}`) return answer(200, ++seen.polls < 2 ? { state: 'building' } : { state: 'built', cid, size: big.length });
					if (method === 'DELETE') return seen.deleteTries = (seen.deleteTries ?? 0) + 1, seen.deleteTries <= dropFails ? Promise.reject(new Error('the connection closed')) : (++seen.deleted, answer(200, { removed: true }));
					if (gone) return answer(404, { error: 'no such job' });
					const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec(init.headers.range);
					down += Number(b) - Number(a) + 1;
					if (down > maxBytes || breakAt.includes(number)) {
						close();
						throw new Error('the connection closed while waiting for the answer');
					}
					return { status: 206, body: big.slice(Number(a), Number(b) + 1) };
				}
			};
		};
		return { seen, open };
	}
	// The relay's limits as deployed, and everything a sixteenth of its size so
	// the tests stay quick: the image, the relay's limit, a run and a piece
	// keep the proportions the app has.
	const RELAY_BYTES = 4 * 1024 * 1024;
	const SCALE = 16;
	const big = new Uint8Array((10 * 1024 * 1024) / SCALE + 4321);
	for (let n = 0; n < big.length; n++) big[n] = (n * 31 + (n >> 11)) & 255;
	const real = () => ({ sleep: async () => {}, read: async () => 'processed', now: () => 1_800_000_000_000, kept: { current: null }, runBytes: RUN_BYTES / SCALE, pieceBytes: PIECE_BYTES / SCALE });

	it('asks for runs larger than a strict relay carries, made of whole pieces, in no more lanes than a client may open', () => {
		expect(RUN_BYTES).toBeGreaterThan(RELAY_BYTES);
		expect(RUN_BYTES % PIECE_BYTES).toBe(0);
		expect(LANES).toBeLessThanOrEqual(4);
	});

	it('takes a run over one connection where the relay lets a builder carry more', async () => {
		const { seen, open } = relayedBuilder(big, { maxBytes: (256 * 1024 * 1024) / SCALE });
		const { got, store } = fakeStore();
		await buildSealedImage({ passphrase, app, channel, builder, open, store, ...real() });
		expect(await digest(got.bytes)).toBe(await digest(big));
		// The build, one per run, the drop: one attestation per run.
		expect(seen.opened).toBe(1 + Math.ceil(big.length / (RUN_BYTES / SCALE)) + 1);
	});


	it('fetches through a relay that carries 4 MiB a connection and four connections a client', async () => {
		const { seen, open } = relayedBuilder(big);
		const { got, store } = fakeStore();
		const shown = [];
		const result = await buildSealedImage({ passphrase, app, channel, builder: { ...builder, vprogram: '12'.repeat(32) }, open, store, onProgress: (p) => p.step === 'fetch' && shown.push(Math.floor((p.data.got / p.data.size) * 100)), ...real() });
		expect(got.bytes.length).toBe(big.length);
		expect(await digest(got.bytes)).toBe(await digest(big));
		// One connection for the build, one per 4 MiB the relay carries (a run goes
		// on where the relay cut it), one to have it dropped.
		expect(seen.opened).toBe(1 + Math.ceil(big.length / (RELAY_BYTES / SCALE)) + 1);
		expect(seen.mostOpen).toBeLessThanOrEqual(LANES);
		expect(seen.open).toBe(0);
		expect(seen.deleted).toBe(1);
		expect(shown.at(0)).toBe(0);
		expect(shown.at(-1)).toBe(100);
		// What the hardware reported at the build is kept beside the image.
		expect(result.attested).toEqual({ vprogram: '12'.repeat(32), measurement: 'ab'.repeat(48), at: '2027-01-15T08:00:00.000Z' });
	});

	it('fetches a run again when its connection breaks, and asks on over a new one while the image is built', async () => {
		// Connection 1 builds; 2 and 3 break off at once; later ones carry the image.
		const { seen, open } = relayedBuilder(big, { breakAt: [2, 3] });
		const { got, store } = fakeStore();
		await buildSealedImage({ passphrase, app, channel, builder, open, store, ...real() });
		expect(await digest(got.bytes)).toBe(await digest(big));
		expect(seen.builds).toBe(1);

		// The relay ends the connection of the build while the app waits.
		const slow = fakeBuilder();
		let opened = 0;
		let asked = 0;
		const dropping = async () => {
			const channel = await slow.open();
			const mine = ++opened;
			return { ...channel, request: (method, path, init) => (method === 'GET' && path === `/job/${job}` && mine === 1 && ++asked ? Promise.reject(new Error('the connection closed')) : channel.request(method, path, init)) };
		};
		await buildSealedImage({ passphrase, app, channel, builder, open: dropping, store: fakeStore().store, ...quick() });
		expect(asked).toBe(1);
		expect(slow.seen.calls.filter((c) => c.path === '/build')).toHaveLength(1);
	});

	it('goes on where a broken connection stopped, and keeps trying while pieces come back', async () => {
		// Every connection breaks after one piece (an unsteady VPN): the run goes
		// on from there each time, so with two tries in a row it still completes.
		const inner = fakeBuilder();
		const ranges = [];
		let counted = 0;
		const shaky = async () => {
			const channel = await inner.open();
			let pieces = 0;
			return { ...channel, request: (method, path, init) => {
				if (path === `/job/${job}/image`) {
					if (++pieces > 1) return Promise.reject(new Error('the connection closed while waiting for the answer'));
					ranges.push(init.headers.range);
				}
				return channel.request(method, path, init);
			} };
		};
		const { got, store } = fakeStore();
		await buildSealedImage({ passphrase, app, channel, builder, open: shaky, store, ...quick(), runTries: 2, onProgress: () => {} });
		expect(got.bytes).toEqual(image);
		expect(ranges).toEqual(['bytes=0-999', 'bytes=1000-1999', 'bytes=2000-2499']);

		// No piece at all, try after try: it gives up after runTries in a row.
		let tries = 0;
		const dead = async () => {
			const channel = await inner.open();
			return { ...channel, request: (method, path, init) => (path === `/job/${job}/image` ? (tries++, Promise.reject(new Error('closed'))) : channel.request(method, path, init)) };
		};
		await expect(buildSealedImage({ passphrase, app, channel, builder, open: dead, store: fakeStore().store, ...quick(), runTries: 3 })).rejects.toThrow(SealedImageError);
		expect(tries).toBe(3);
	});

	it('reports what happens as data for the progress view: hashes, sizes, connections, and no secret', async () => {
		const { open } = fakeBuilder();
		const relayed = async () => Object.assign(await open(), { relay: 'relay.example.test', measurement: 'ab'.repeat(48) });
		const { store } = fakeStore();
		const seen = [];
		const result = await buildSealedImage({ passphrase, app, channel, builder, open: relayed, store, onProgress: (p) => seen.push(p), ...quick() });
		const last = (step) => seen.filter((p) => p.step === step).at(-1)?.data;
		expect(last('attest')).toEqual({ relay: 'relay.example.test', measurement: 'ab'.repeat(48) });
		expect(last('build')).toEqual({ plainSha256: builder.plain.sha256, cid, size: image.length });
		expect(last('fetch')).toMatchObject({ got: image.length, size: image.length, lanes: expect.any(Number) });
		expect(last('fetch').attested).toBeGreaterThanOrEqual(2);
		expect(last('sign')).toEqual({ cid, storeHash: result.storeHash });
		expect(last('upload')).toEqual({ size: image.length, host: 'api2.aleph.im', attempt: 1 });
		expect(last('confirm')).toEqual({ storeHash: result.storeHash, processed: true });
		// Nothing the progress view gets may hold the passphrase.
		expect(JSON.stringify(seen)).not.toContain(passphrase);
		expect(relayHost('wss://relay.example.test/attest')).toBe('relay.example.test');
		expect(relayHost('/dns4/relay.example.test/tcp/443/tls/ws/p2p/x')).toBe('relay.example.test');
	});

	it('uploads again over another API node when the connection breaks, unless Aleph has the STORE already', async () => {
		const hosts = [];
		let tries = 0;
		const flaky = async (blob, message, host) => {
			hosts.push(host);
			if (++tries === 1) throw new TypeError('Failed to fetch');
			return { status: 200, cid };
		};
		const { open } = fakeBuilder();
		let asked = 0;
		// Not there after the broken upload; processed after the second one.
		const read = async () => (asked++ === 0 ? null : 'processed');
		const result = await buildSealedImage({ passphrase, app, channel, builder, open, store: flaky, ...quick(), read });
		expect(result.storeHash).toMatch(/^[0-9a-f]{64}$/);
		expect(hosts).toEqual(['https://api2.aleph.im', 'https://api3.aleph.im']);

		// The upload broke, but Aleph got it: no second upload.
		let uploads = 0;
		const lost = async () => {
			uploads++;
			throw new TypeError('Failed to fetch');
		};
		await buildSealedImage({ passphrase, app, channel, builder, open: fakeBuilder().open, store: lost, ...quick(), read: async () => 'pending' }).catch(() => {});
		expect(uploads).toBe(1);

		// A refusal is final; three broken tries end with a clear message.
		let refused = 0;
		await expect(buildSealedImage({ passphrase, app, channel, builder, open: fakeBuilder().open, store: async () => (refused++, { status: 402, cid: null, reason: 'no credits' }), ...quick() })).rejects.toThrow(SealedImageError);
		expect(refused).toBe(1);
		let broken = 0;
		await expect(buildSealedImage({ passphrase, app, channel, builder, open: fakeBuilder().open, store: async () => { broken++; throw new TypeError('Failed to fetch'); }, ...quick(), read: async () => null })).rejects.toThrow({ code: 'upload-broken' });
		expect(broken).toBe(3);
	});

	it('gives up where trying again cannot help: the image is gone, or a connection fails its attestation', async () => {
		const lost = relayedBuilder(big, { gone: true });
		await expect(buildSealedImage({ passphrase, app, channel, builder, open: lost.open, store: fakeStore().store, ...real() })).rejects.toThrow({ code: 'image-gone', detail: { status: 404 } });
		expect(lost.seen.opened).toBeLessThanOrEqual(1 + LANES + 1);

		// The third connection shows another measurement: nothing is fetched over it, and nothing is stored.
		const other = relayedBuilder(big, { refuseAt: 3 });
		const { got, store } = fakeStore();
		await expect(buildSealedImage({ passphrase, app, channel, builder, open: other.open, store, ...real() })).rejects.toThrow('measurement mismatch');
		expect(got.message).toBeNull();
		expect(other.seen.open).toBe(0);

		// A run that never arrives ends the fetch after a few tries, not never.
		const dead = relayedBuilder(big, { breakAt: Array.from({ length: 200 }, (_, n) => n + 2) });
		await expect(buildSealedImage({ passphrase, app, channel, builder, open: dead.open, store: fakeStore().store, ...real() })).rejects.toThrow({ code: 'piece-missing' });
		expect(dead.seen.opened).toBeLessThan(40);
	});

	it('uploads a fetched image again without building it again, and only waits when it was uploaded', async () => {
		const { seen, open } = fakeBuilder();
		const kept = { current: null };
		const stores = [];
		const failing = async () => (stores.push('refused'), { status: 500, cid: null });
		const { got, store } = fakeStore();
		const counted = async (blob, message) => (stores.push('taken'), store(blob, message));
		await expect(buildSealedImage({ passphrase, app, channel, builder, open, store: failing, ...quick(), kept })).rejects.toThrow({ code: 'upload-refused' });
		const builderCalls = seen.calls.length;
		// Aleph has it, but does not confirm in time.
		await expect(buildSealedImage({ passphrase, app, channel, builder, open, store: counted, ...quick(), kept, read: async () => null, confirmTries: 2 })).rejects.toThrow({ code: 'store-pending' });
		const result = await buildSealedImage({ passphrase, app, channel, builder, open, store: counted, ...quick(), kept });
		expect(seen.calls.length).toBe(builderCalls);
		expect(stores).toEqual(['refused', 'taken']);
		expect(got.bytes).toEqual(image);
		expect(result.storeHash).toBe(got.message.item_hash);
		expect(kept.current).toBeNull();

		// Another vault in the same window gets nothing of it.
		const left = { current: null };
		await expect(buildSealedImage({ passphrase, app, channel, builder, open, store: failing, ...quick(), kept: left })).rejects.toThrow();
		const before = seen.calls.length;
		await buildSealedImage({ passphrase, channel, app: privateKeyToAccount(`0x${'22'.repeat(32)}`), builder, open, store: fakeStore().store, ...quick(), kept: left });
		expect(seen.calls.slice(before).some((c) => c.path === '/build')).toBe(true);

		// Refused by Aleph after the upload: the next try signs and uploads anew.
		const again = { current: null };
		await expect(buildSealedImage({ passphrase, app, channel, builder, open, store: fakeStore().store, ...quick(), kept: again, read: async () => 'rejected' })).rejects.toThrow({ code: 'store-rejected' });
		expect(again.current.message).toBeUndefined();
	});

	it('reaches the builder over the relay that worked last, and never retries a refused attestation', async () => {
		const dialled = [];
		const works = { b: true };
		const load = async () => ({
			wasm: {},
			relays: ['a', 'b', 'c'],
			relayTransports: ([relay]) => (route) => ({ relay, route, onData: () => {} }),
			attestGuest: async ({ transport, expectedMeasurements, expectedPolicy }) => {
				dialled.push(transport.relay);
				expect(transport.route).toBe(builder.route);
				expect([expectedMeasurements, expectedPolicy]).toEqual([builder.measurements, builder.policy]);
				if (works[transport.relay] === 'refuse') throw new Error('attestation rejected: measurement');
				if (!works[transport.relay]) throw new Error('connection to the relay closed');
				return { channel: { request: async () => ({ status: 200, body: new Uint8Array(0) }), close: () => {} }, freshVerified: { measurement: 'ab'.repeat(48) } };
			}
		});
		const open = attestedOpener(builder, load);
		expect((await open()).measurement).toBe('ab'.repeat(48));
		await open();
		expect(dialled).toEqual(['a', 'b', 'b']);
		works.b = false;
		await expect(open()).rejects.toThrow({ code: 'unreachable' });
		works.c = 'refuse';
		works.b = true;
		dialled.length = 0;
		works.b = false;
		await expect(open()).rejects.toThrow(/attestation rejected/);
		expect(dialled).toEqual(['b', 'c']);
	});

	it('tries a run again when the builder cannot be reached for a moment, and the cleanup too', async () => {
		// Connections 4 and 5 find no way to the builder; the runs they were for are fetched again.
		const flaky = relayedBuilder(big, { unreachableAt: [4, 5], dropFails: 2 });
		const { got, store } = fakeStore();
		await buildSealedImage({ passphrase, app, channel, builder, open: flaky.open, store, ...real() });
		expect(await digest(got.bytes)).toBe(await digest(big));
		// The image is dropped even though the first two tries broke off.
		expect(flaky.seen.deleteTries).toBe(3);
		expect(flaky.seen.deleted).toBe(1);
		expect(flaky.seen.open).toBe(0);
		expect(LANES).toBeLessThan(4);
	});
});

describe('a builder started for each build', () => {
	const crn = '0c'.repeat(32);
	const program = {
		allow_amend: false,
		environment: { internet: true },
		metadata: { name: 'sealed-image-builder' },
		payment: { type: 'credit' },
		requirements: { node: { node_hash: crn } },
		resources: { memory: 6144, seconds: 30, vcpus: 2 },
		runtime: { comment: '', ref: '0d'.repeat(32) },
		verification: { backend: 'sev_snp', measurements: [{ platform: 'sev_snp', registers: { launch: 'ab'.repeat(48) } }], policy: 196608 },
		volumes: [{ comment: '', hash_tree: '0e'.repeat(32), ref: '2e'.repeat(32), roothash: '0f'.repeat(32) }],
		workload: { hash_tree: '1a'.repeat(32), ref: '2a'.repeat(32), roothash: '1b'.repeat(32) }
	};
	const { route: _route, ...fixed } = builder;
	const template = { ...fixed, program, crn, policy: 196608 };
	const unreachable = () => new AlephVmError('not up yet', 'unreachable');

	function fakeAleph({ refuse = [] } = {}) {
		const sent = [];
		const post = async (message) => {
			sent.push({ type: message.type, hash: message.item_hash, content: JSON.parse(message.item_content) });
			if (refuse.includes(message.type)) throw new AlephVmError('refused', 'refused');
		};
		return { sent, post };
	}
	const fresh = (over) => ({ passphrase, app, channel, builder: template, ...quick(), upMs: 0, ...over });

	it('takes a builder fixed by its content and node, without a route', () => {
		expect(checkBuilder(template)).toBe(template);
		expect(() => checkBuilder({ ...template, crn: 'x' })).toThrow({ code: 'no-builder' });
		expect(() => checkBuilder({ ...template, program: {} })).toThrow({ code: 'no-builder' });
		expect(() => checkBuilder({ ...template, plain: { sha256: 'y' } })).toThrow({ code: 'no-plain' });
	});

	it('starts it, waits until it answers attested, builds over it, and forgets it', async () => {
		const { seen, open } = fakeBuilder();
		const { store } = fakeStore();
		const { sent, post } = fakeAleph();
		const noted = [];
		let tries = 0;
		let routed = null;
		const result = await buildOnFreshBuilder(fresh({
			store, post,
			opener: (running) => ((routed = running), async () => (++tries < 3 ? Promise.reject(unreachable()) : open())),
			onStarted: (v) => void noted.push(['started', v]),
			onForgotten: (v) => void noted.push(['forgotten', v])
		}));
		const vprogram = sent[0].hash;
		expect(sent.map((m) => m.type)).toEqual(['V-PROGRAM', 'FORGET']);
		expect(noted).toEqual([['started', vprogram], ['forgotten', vprogram]]);
		expect(routed).toMatchObject({ route: `?crn=${crn}&vm=${vprogram}`, vprogram });
		expect(seen.calls.filter((c) => c.path !== '/')[0]).toMatchObject({ method: 'POST', path: '/build' });
		expect(result.storeHash).toMatch(/^[0-9a-f]{64}$/);
	});

	it('starts one more builder when another address claimed the first, and gives up when that one is claimed too', async () => {
		let builds = 0;
		const claimed = { status: 403, body: encoder.encode('{"error":"claimed by another address; start another builder"}') };
		const { open } = fakeBuilder({ 'POST /build': () => (++builds === 1 ? claimed : { status: 202, body: encoder.encode(JSON.stringify({ job })) }) });
		const { sent, post } = fakeAleph();
		const result = await buildOnFreshBuilder(fresh({ store: fakeStore().store, post, opener: () => open }));
		expect(builds).toBe(2);
		expect(sent.map((m) => m.type)).toEqual(['V-PROGRAM', 'FORGET', 'V-PROGRAM', 'FORGET']);
		expect(sent[0].hash).not.toBe(sent[2].hash);
		expect(result.storeHash).toMatch(/^[0-9a-f]{64}$/);

		const always = fakeBuilder({ 'POST /build': () => claimed });
		const twice = fakeAleph();
		await expect(buildOnFreshBuilder(fresh({ post: twice.post, opener: () => always.open }))).rejects.toThrow({ code: 'claimed' });
		expect(twice.sent.map((m) => m.type)).toEqual(['V-PROGRAM', 'FORGET', 'V-PROGRAM', 'FORGET']);
	});

	it('forgets it also when the build fails', async () => {
		const { open } = fakeBuilder({ 'POST /build': () => ({ status: 500, body: encoder.encode('{"error":"broken"}') }) });
		const { sent, post } = fakeAleph();
		await expect(buildOnFreshBuilder(fresh({ post, opener: () => open }))).rejects.toThrow({ code: 'not-accepted' });
		expect(sent.map((m) => m.type)).toEqual(['V-PROGRAM', 'FORGET']);
	});

	it('starts none when this page already holds the sealed image', async () => {
		const { sent, post } = fakeAleph();
		const { got, store } = fakeStore();
		const kept = { current: { key: `${app.address.toLowerCase()}/${builder.plain.sha256}`, cid, size: image.length, image: new Blob([image]), attested: null } };
		await buildOnFreshBuilder(fresh({ store, post, kept, opener: () => async () => { throw new Error('no builder needed'); } }));
		expect(sent).toEqual([]);
		expect(got.bytes).toEqual(image);
	});

	it('signs the STORE in the payer\'s name when a payer is given', async () => {
		const payer = '0x' + '44'.repeat(20);
		const message = await storeMessage(app, cid, { channel, time: 1_800_000_000, payer });
		expect(JSON.parse(message.item_content).address).toBe(payer);
		expect(message.sender).toBe(app.address);
		expect(await recoverMessageAddress({ message: ['ETH', app.address, 'STORE', message.item_hash].join('\n'), signature: message.signature })).toBe(app.address);
	});
});

describe('limits and credits', () => {
	it('takes a plain image up to 992 MiB: the Belege bridge (959 MiB) and Paperless anywhere (836 MiB) fit', () => {
		expect(MAX_SEALED_BYTES).toBe(1024 ** 3);
		expect(MAX_PLAIN_BYTES).toBe(992 * 1024 ** 2);
		expect(959 * 1024 ** 2).toBeLessThanOrEqual(MAX_PLAIN_BYTES);
		expect(876_609_536).toBeLessThanOrEqual(MAX_PLAIN_BYTES);
	});
	it('asks a payer for a day of the builder, the image and what it already spends', () => {
		expect(creditsForBuild({ builderPerHour: 85_500, spendingPerHour: 1000 })).toBe(Math.ceil((85_500 + IMAGE_STORE_CREDITS_PER_HOUR + 1000) * 24));
		expect(creditsForBuild()).toBe(Math.ceil((BUILDER_CREDITS_PER_HOUR + IMAGE_STORE_CREDITS_PER_HOUR) * 24));
	});
});

describe('the passphrase', () => {
	it('is derived as Paperless anywhere derives it, one per root key, label and plain image', async () => {
		const root = new Uint8Array(32).fill(7);
		const paperless = await derivePassphrase(root, { label: 'paperless-anywhere/image-passphrase/v1', plainSha256: 'ef'.repeat(32) });
		// Paperless anywhere's keys/derive.js (noble HKDF) for the same input.
		expect(paperless).toBe('sVQDjSiu8aZkWwZm9uUKM1Yf4pscRRebLMWxZ8S79D8');
		expect(passphrase).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(await derivePassphrase(root, { label: 'example/image-passphrase/v1', plainSha256: '00'.repeat(32) })).not.toBe(passphrase);
		expect(await derivePassphrase(new Uint8Array(32).fill(8), { label: 'example/image-passphrase/v1', plainSha256: 'ef'.repeat(32) })).not.toBe(passphrase);
		await expect(derivePassphrase(root, { label: 'example', plainSha256: 'nope' })).rejects.toThrow(/SHA-256/);
		await expect(derivePassphrase(new Uint8Array(31), { label: 'example', plainSha256: 'ef'.repeat(32) })).rejects.toThrow(/32 bytes/);
		await expect(derivePassphrase(root, { label: 'with space', plainSha256: 'ef'.repeat(32) })).rejects.toThrow(/label/);
	});
	it('goes to no builder unless it is one line of 32 to 256 characters', async () => {
		await expect(buildSealedImage({ passphrase: 'short', app, channel, builder, open: async () => { throw new Error('never opened'); }, ...quick() })).rejects.toThrow({ code: 'bad-passphrase' });
	});
});
