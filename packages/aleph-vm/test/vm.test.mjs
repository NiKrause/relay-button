import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { recoverMessageAddress } from 'viem';
import { checkOwnInstance, forgetMessage, instanceMessage, ownInstances, sha256Hex, twoN6Host, validHost } from '../src/index.mjs';

const app = privateKeyToAccount(generatePrivateKey());
const payer = privateKeyToAccount(generatePrivateKey()).address;
const signed = (m) => recoverMessageAddress({ message: [m.chain, m.sender, m.type, m.item_hash].join('\n'), signature: m.signature });
const tee = { mode: 'sev_snp', policy: 196608, runtime: '1'.repeat(64), measurements: [{ platform: 'sev_snp', registers: { launch: 'a'.repeat(96) }, vcpu_type: 'EPYC-Genoa' }] };
const vm = { app, payer, channel: 'example-app', rootfsItemHash: 'b'.repeat(64), rootfsSizeMiB: 40 * 1024, vcpus: 2, memoryMiB: 4096, crnHash: 'c'.repeat(64), trustedExecution: tee, name: 'example-x' };

describe('delegated messages', () => {
	it('an INSTANCE is owned and paid by the payer, signed by the app', async () => {
		const m = await instanceMessage(vm);
		const content = JSON.parse(m.item_content);
		assert.equal(m.type, 'INSTANCE');
		assert.equal(m.sender, app.address);
		assert.equal(m.channel, 'example-app');
		assert.equal(content.address, payer);
		assert.equal(m.item_hash, await sha256Hex(m.item_content));
		assert.equal(await signed(m), app.address);
		assert.equal(content.environment.trusted_execution.measurements[0].registers.launch, 'a'.repeat(96));
		assert.deepEqual(content.volumes, []);
	});
	it('an INSTANCE takes extra volumes when given', async () => {
		const volume = { comment: 'data', mount: '/srv/data', persistence: 'host', name: 'data', size_mib: 1024 };
		assert.deepEqual(JSON.parse((await instanceMessage({ ...vm, volumes: [volume] })).item_content).volumes, [volume]);
	});
	it('a FORGET on behalf of the payer keeps the payer as address', async () => {
		const m = await forgetMessage(app, ['d'.repeat(64)], { channel: 'example-app', reason: 'stop', payer });
		assert.equal(m.sender, app.address);
		assert.equal(JSON.parse(m.item_content).address, payer);
		assert.deepEqual(JSON.parse(m.item_content).hashes, ['d'.repeat(64)]);
		assert.equal(await signed(m), app.address);
	});
});

describe('ownInstances', () => {
	const app = '0x' + '11'.repeat(20);
	const payer = '0x' + '33'.repeat(20);
	const msg = (sender, name, time, address = payer) => ({ item_hash: name + time, sender, time, content: { address, metadata: { name }, requirements: { node: { node_hash: 'n' } } } });
	it('keeps only VMs with the prefix this app sent, newest first', () => {
		const list = ownInstances([
			msg(app.toUpperCase().replace('0X', '0x'), 'paperless-a', 1),
			msg(app, 'paperless-b', 3),
			msg('0x' + '22'.repeat(20), 'paperless-c', 2),
			msg(app, 'relay-x', 4),
			msg(app, 'paperless-other-payer', 5, '0x' + '44'.repeat(20))
		], app, { payer, namePrefix: 'paperless-' });
		assert.deepEqual(list.map((v) => v.name), ['paperless-b', 'paperless-a']);
		assert.deepEqual({ createdAt: list[0].createdAt, crnHash: list[0].crnHash, payer: list[0].payer }, { createdAt: 3000, crnHash: 'n', payer });
	});
	it('without a payer, keeps every payer and says who pays each', () => {
		const list = ownInstances([msg(app, 'paperless-wallet', 1), msg(app, 'paperless-self', 2, app)], app);
		assert.deepEqual(list.map((v) => [v.name, v.payer]), [['paperless-self', app], ['paperless-wallet', payer]]);
	});
});

describe('checkOwnInstance', () => {
	it('returns the content of an INSTANCE this app key signed', async () => {
		const m = await instanceMessage(vm);
		const content = await checkOwnInstance(app.address, m.item_hash, m);
		assert.equal(content.environment.trusted_execution.measurements[0].registers.launch, 'a'.repeat(96));
	});
	it('refuses changed content and another signer', async () => {
		const m = await instanceMessage(vm);
		const changed = { ...m, item_content: m.item_content.replace('a'.repeat(96), 'f'.repeat(96)) };
		await assert.rejects(checkOwnInstance(app.address, m.item_hash, changed), { code: 'content-mismatch' });
		const other = privateKeyToAccount(generatePrivateKey());
		await assert.rejects(checkOwnInstance(other.address, m.item_hash, m), { code: 'not-ours' });
	});
});

describe('host names', () => {
	it('takes only one label under 2n6.me from 2n6', () => {
		assert.equal(twoN6Host('abc123'), 'abc123.2n6.me');
		assert.equal(twoN6Host('https://abc123.2n6.me/'), 'abc123.2n6.me');
		for (const bad of ['', 'abc.2n6.me.example.com', 'example.com', 'a_b', '-a', 'abc.2n6.me/x', 'abc.2n6.me:8443', 'http://abc.2n6.me', 'user@abc.2n6.me']) assert.equal(twoN6Host(bad), null, bad);
	});
	it('takes a plain name with a port at most', () => {
		assert.equal(validHost('abcdefghijklmnop.vm.le-space.de:24000'), true);
		assert.equal(validHost('abc.2n6.me'), true);
		for (const bad of ['h.example/x', 'h.example:0', 'h.example:70000', 'h.example:', 'user@h.example', '1.2.3.4', '1.2.3.4:443', 'localhost', '', null]) assert.equal(validHost(bad), false, String(bad));
	});
});
