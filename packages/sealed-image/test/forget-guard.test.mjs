import { describe, it } from 'node:test';
import { expect } from './expect.mjs';
import { BUILDER_VOLUME_MAX_BYTES, builderVolumesToForget, forgetRefusal, volumeRefs } from '../src/forget-guard.mjs';

const account = '0x' + 'a'.repeat(40);
const h = (c) => c.repeat(64);
const store = (c, over = {}) => ({ hash: h(c), status: 'processed', type: 'STORE', sender: account, size: 300e6, ...over });
const o = (named, kept = []) => ({ account, named: new Set(named.map(h)), kept: new Set(kept.map(h)) });

describe('volumeRefs', () => {
	it('reads the workload, the volumes and their hash trees', () => {
		const content = { workload: { ref: h('1'), hash_tree: h('2') }, volumes: [{ ref: h('3'), hash_tree: h('4') }, { ref: h('3') }] };
		expect(volumeRefs(content)).toEqual([h('1'), h('2'), h('3'), h('4')]);
	});
});

describe('forgetRefusal', () => {
	it('lets a volume of the builder being deleted go', () => {
		expect(forgetRefusal(store('1'), o(['1']))).toBeNull();
	});
	it('refuses a STORE the builder does not name', () => {
		expect(forgetRefusal(store('9'), o(['1']))).toMatch(/not a volume/);
	});
	it('refuses an image, even when a builder names it', () => {
		expect(forgetRefusal(store('1', { size: 943718400 }), o(['1']))).toMatch(/an image/);
		expect(forgetRefusal(store('1', { size: BUILDER_VOLUME_MAX_BYTES + 1 }), o(['1']))).toMatch(/an image/);
	});
	it('refuses a STORE of unknown size', () => {
		expect(forgetRefusal(store('1', { size: null }), o(['1']))).toMatch(/size unknown/);
	});
	it('refuses what the kept list names', () => {
		expect(forgetRefusal(store('1'), o(['1'], ['1']))).toMatch(/named in the kept list/);
	});
	it('refuses a STORE of another account or one not processed', () => {
		expect(forgetRefusal(store('1', { sender: '0x' + 'b'.repeat(40) }), o(['1']))).toMatch(/sent by/);
		expect(forgetRefusal(store('1', { status: 'forgotten' }), o(['1']))).toMatch(/not a processed STORE/);
	});
});

describe('builderVolumesToForget', () => {
	it('forgets nothing when one STORE is refused', () => {
		const r = builderVolumesToForget([store('1'), store('2', { size: 943718400 })], o(['1', '2']));
		expect(r.forget).toEqual([]);
		expect(r.refused).toHaveLength(1);
	});
	it('forgets the volumes when all may go', () => {
		expect(builderVolumesToForget([store('1'), store('2', { size: 2e6 })], o(['1', '2'])).forget).toEqual([h('1'), h('2')]);
	});
});
