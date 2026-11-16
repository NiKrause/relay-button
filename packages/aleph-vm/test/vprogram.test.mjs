import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { privateKeyToAccount } from 'viem/accounts';
import { recoverMessageAddress } from 'viem';
import { AlephVmError, attestedOpener, callJson, checkTemplate, forgetVProgram, relayHost, runOnFreshVProgram, sha256Hex, templateMismatches, vprogramMessage } from '../src/index.mjs';

const app = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const channel = 'example-app';
const crn = '0c'.repeat(32);
const measurements = ['ab'.repeat(48)];
const program = {
	allow_amend: false,
	environment: { internet: true },
	metadata: { name: 'sealed-image-builder' },
	payment: { type: 'credit' },
	requirements: { node: { node_hash: crn } },
	resources: { memory: 6144, seconds: 30, vcpus: 2 },
	runtime: { comment: '', ref: '0d'.repeat(32) },
	verification: { backend: 'sev_snp', measurements: [{ platform: 'sev_snp', registers: { launch: measurements[0] } }], policy: 196608 },
	volumes: [{ comment: '', hash_tree: '0e'.repeat(32), ref: '2e'.repeat(32), roothash: '0f'.repeat(32) }],
	workload: { hash_tree: '1a'.repeat(32), ref: '2a'.repeat(32), roothash: '1b'.repeat(32) }
};
const template = { program, crn, measurements, policy: 196608 };
const unreachable = () => new AlephVmError('not up yet', 'unreachable');
const encoder = new TextEncoder();
const quick = { sleep: async () => {}, upMs: 0 };

/** Aleph as far as a run goes: what was sent, in order. */
function fakeAleph({ refuse = [] } = {}) {
	const sent = [];
	const post = async (message) => {
		sent.push({ type: message.type, hash: message.item_hash, content: JSON.parse(message.item_content) });
		if (refuse.includes(message.type)) throw new AlephVmError('refused', 'refused');
	};
	return { sent, post };
}

/** A channel whose `GET /` answers like a workload that is up. */
const upChannel = (over = {}) => ({
	closed: 0,
	close() { this.closed++; },
	request: async (method, path) => over[`${method} ${path}`]?.() ?? { status: 200, body: encoder.encode('{"service":"x"}') }
});

describe('a V-PROGRAM template', () => {
	it('is complete with content, node, measurements and policy', () => {
		assert.equal(checkTemplate(template), template);
		assert.throws(() => checkTemplate({ ...template, crn: 'x' }), { code: 'no-template' });
		assert.throws(() => checkTemplate({ ...template, program: {} }), { code: 'no-template' });
		assert.throws(() => checkTemplate({ ...template, measurements: [] }), { code: 'no-template' });
	});
	it('names what it pins beside it, and nothing of one publication', () => {
		assert.deepEqual(templateMismatches(template), []);
		assert.deepEqual(templateMismatches({ ...template, measurements: ['cd'.repeat(48)] }), ['measurements']);
		assert.deepEqual(templateMismatches({ ...template, program: { ...program, address: app.address, time: 1 } }), ['address', 'time']);
	});
	it('is signed as the app, with the payer as address and its own time', async () => {
		const message = await vprogramMessage(app, template, { channel, time: 1_800_000_000 });
		assert.deepEqual(JSON.parse(message.item_content), { ...program, address: app.address, time: 1_800_000_000 });
		assert.equal(message.type, 'V-PROGRAM');
		assert.equal(message.sender, app.address);
		assert.equal(message.channel, channel);
		assert.equal(message.item_hash, await sha256Hex(message.item_content));
		assert.equal(await recoverMessageAddress({ message: ['ETH', app.address, 'V-PROGRAM', message.item_hash].join('\n'), signature: message.signature }), app.address);
		const payer = '0x' + '44'.repeat(20);
		assert.equal(JSON.parse((await vprogramMessage(app, template, { channel, payer })).item_content).address, payer);
		await assert.rejects(vprogramMessage(app, { ...template, crn: 'x' }, { channel }), { code: 'no-template' });
	});
});

describe('a V-PROGRAM started for one run', () => {
	it('starts it, waits until it answers attested, runs the work, and forgets it', async () => {
		const { sent, post } = fakeAleph();
		const noted = [];
		let routed = null;
		let tries = 0;
		const first = upChannel();
		const result = await runOnFreshVProgram({
			app, template, channel, post, ...quick,
			opener: (running) => ((routed = running), async () => (++tries < 3 ? Promise.reject(unreachable()) : first)),
			onStarted: (v) => void noted.push(['started', v, sent.length]),
			onForgotten: (v) => void noted.push(['forgotten', v]),
			work: async ({ open, vprogram }) => {
				assert.equal(await open(), first, 'the first open hands over the channel that was ready');
				return { vprogram };
			}
		});
		const vprogram = sent[0].hash;
		assert.deepEqual(sent.map((m) => m.type), ['V-PROGRAM', 'FORGET']);
		assert.deepEqual(sent[1].content.hashes, [vprogram]);
		assert.deepEqual(noted, [['started', vprogram, 1], ['forgotten', vprogram]]);
		assert.equal(routed.route, `?crn=${crn}&vm=${vprogram}`);
		assert.equal(routed.vprogram, vprogram);
		assert.deepEqual(routed.measurements, measurements);
		assert.ok(tries >= 3);
		assert.deepEqual(result, { vprogram });
	});

	it('waits while the guest attests but its workload answers "upstream not ready"', async () => {
		let hellos = 0;
		const c = upChannel({ 'GET /': () => ({ status: ++hellos < 3 ? 503 : 200, body: encoder.encode(hellos < 3 ? '{"error":"upstream not ready"}' : '{"service":"x"}') }) });
		const { sent, post } = fakeAleph();
		await runOnFreshVProgram({ app, template, channel, post, ...quick, opener: () => async () => c, work: async () => null });
		assert.equal(hellos, 3);
		assert.equal(c.closed, 2, 'channels that were not ready are closed');
		assert.deepEqual(sent.map((m) => m.type), ['V-PROGRAM', 'FORGET']);
	});

	it('forgets it also when the work fails', async () => {
		const { sent, post } = fakeAleph();
		await assert.rejects(runOnFreshVProgram({ app, template, channel, post, ...quick, opener: () => async () => upChannel(), work: async () => { throw new Error('broken'); } }), /broken/);
		assert.deepEqual(sent.map((m) => m.type), ['V-PROGRAM', 'FORGET']);
	});

	it('forgets it when it never answers, and at once when its attestation is refused', async () => {
		const never = fakeAleph();
		await assert.rejects(runOnFreshVProgram({ app, template, channel, post: never.post, ...quick, upTries: 3, opener: () => async () => Promise.reject(unreachable()), work: async () => null }), { code: 'unreachable' });
		assert.deepEqual(never.sent.map((m) => m.type), ['V-PROGRAM', 'FORGET']);
		const refused = fakeAleph();
		let tries = 0;
		await assert.rejects(runOnFreshVProgram({ app, template, channel, post: refused.post, ...quick, opener: () => async () => (tries++, Promise.reject(new Error('launch measurement rejected'))), work: async () => null }), /measurement/);
		assert.equal(tries, 1);
		assert.deepEqual(refused.sent.map((m) => m.type), ['V-PROGRAM', 'FORGET']);
	});

	it('notes nothing and forgets nothing when Aleph refuses the V-PROGRAM (no credits)', async () => {
		const { sent, post } = fakeAleph({ refuse: ['V-PROGRAM'] });
		const noted = [];
		await assert.rejects(runOnFreshVProgram({ app, template, channel, post, ...quick, opener: () => async () => upChannel(), work: async () => null, onStarted: () => void noted.push('started'), onForgotten: () => void noted.push('forgotten') }), /refused/);
		assert.deepEqual(sent.map((m) => m.type), ['V-PROGRAM']);
		assert.deepEqual(noted, []);
	});

	it('keeps the note while the FORGET fails', async () => {
		const { sent, post } = fakeAleph({ refuse: ['FORGET'] });
		const noted = [];
		await runOnFreshVProgram({ app, template, channel, post, ...quick, opener: () => async () => upChannel(), work: async () => null, onStarted: () => void noted.push('started'), onForgotten: () => void noted.push('forgotten') });
		assert.ok(sent.filter((m) => m.type === 'FORGET').length > 1);
		assert.deepEqual(noted, ['started']);
	});

	it('forgets one a closed window left, in the payer\'s name', async () => {
		const left = fakeAleph();
		const payer = '0x' + '55'.repeat(20);
		assert.equal(await forgetVProgram(app, '2c'.repeat(32), { channel, payer, post: left.post, sleep: async () => {} }), true);
		assert.deepEqual(left.sent.map((m) => [m.type, m.content.hashes, m.content.address]), [['FORGET', ['2c'.repeat(32)], payer]]);
		const failing = fakeAleph({ refuse: ['FORGET'] });
		assert.equal(await forgetVProgram(app, '2c'.repeat(32), { channel, post: failing.post, sleep: async () => {}, tries: 2 }), false);
		assert.equal(failing.sent.length, 2);
	});
});

describe('an attested channel over relays', () => {
	const target = { route: '?crn=x&vm=y', measurements, policy: 196608 };
	const load = (attestGuest, relays = ['wss://one.example/attest', '/dns4/two.example/tcp/443/wss/p2p/12D3']) => async () => ({ attestGuest, relays, wasm: {}, relayTransports: (r) => (route) => ({ relay: r[0], route }) });

	it('passes the pinned measurements and policy, says which relay and measurement, and starts with the relay that worked last', async () => {
		const used = [];
		let fail = true;
		const attestGuest = async ({ transport, expectedMeasurements, expectedPolicy }) => {
			used.push(transport.relay);
			assert.deepEqual(expectedMeasurements, measurements);
			assert.equal(expectedPolicy, 196608);
			if (transport.relay.startsWith('wss://one') && fail) throw new Error('connection reset');
			return { channel: { request: async () => ({}), close() {} }, freshVerified: { measurement: measurements[0] } };
		};
		const open = attestedOpener(target, load(attestGuest));
		const c = await open();
		assert.equal(c.relay, 'two.example');
		assert.equal(c.measurement, measurements[0]);
		fail = false;
		await open();
		assert.deepEqual(used, ['wss://one.example/attest', '/dns4/two.example/tcp/443/wss/p2p/12D3', '/dns4/two.example/tcp/443/wss/p2p/12D3']);
	});

	it('never tries another relay after a refused attestation; says unreachable when none reaches it', async () => {
		let tries = 0;
		await assert.rejects(attestedOpener(target, load(async () => (tries++, Promise.reject(new Error('launch measurement rejected')))))(), /measurement/);
		assert.equal(tries, 1);
		await assert.rejects(attestedOpener(target, load(async () => Promise.reject(new Error('timeout'))))(), { code: 'unreachable' });
		await assert.rejects(attestedOpener(target, load(async () => ({}), []))(), { code: 'no-relay' });
	});

	it('names a relay by its host only', () => {
		assert.equal(relayHost('wss://relay.example:8443/attest?x=1'), 'relay.example:8443');
		assert.equal(relayHost('/dns4/relay.example/tcp/443/wss'), 'relay.example');
		assert.equal(relayHost('garbage'), '');
	});

	it('reads JSON answers, and a status where there is none', async () => {
		const c = { request: async (_m, path) => ({ status: path === '/' ? 200 : 502, body: encoder.encode(path === '/' ? '{"a":1}' : 'Bad gateway') }) };
		assert.deepEqual(await callJson(c, 'GET', '/'), { status: 200, answer: { a: 1 } });
		assert.deepEqual(await callJson(c, 'GET', '/x'), { status: 502, answer: null });
	});
});
