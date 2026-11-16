import { describe, it } from 'node:test';
import { expect } from './expect.mjs';
import { fallbackPatch, forgetQueued, forgettable, keepPrevious, releasePrevious, startWentWell } from '../src/versions.mjs';

const h = (c) => c.repeat(64);
const own = (store, plain = 'p') => ({ rootfsItemHash: h(store), luksPassphrase: `pass-${store}`, luksFor: h(store), ownImage: { plainSha256: h(plain), rootfsItemHash: h(store) } });

describe('the old own image after a rebuild', () => {
	it('is kept as the way back, not forgotten at the build', () => {
		const saved = keepPrevious(own('a'), own('b', 'q'));
		expect(saved.rootfsItemHash).toBe(h('b'));
		expect(saved.ownImage.previous).toMatchObject({ rootfsItemHash: h('a'), luksPassphrase: 'pass-a', luksFor: h('a') });
		expect(saved.oldOwnImages).toBeUndefined();
	});
	it('built twice before a good start: the older way back stays, the one in between is queued', () => {
		const once = { ...own('a'), ...keepPrevious(own('a'), own('b', 'q')) };
		const twice = keepPrevious(once, own('c', 'r'));
		expect(twice.ownImage.previous.rootfsItemHash).toBe(h('a'));
		expect(twice.oldOwnImages).toEqual([h('b')]);
	});
	it('a first build from the public image keeps nothing', () => {
		expect(keepPrevious({ rootfsItemHash: h('z'), luksPassphrase: 'x', luksFor: h('z') }, own('b')).ownImage.previous).toBeUndefined();
	});
});

describe('after the start', () => {
	it('a good start queues the way back to forget; a failed restore does not count', () => {
		expect(startWentWell({ instanceHash: 'i' })).toBe(true);
		expect(startWentWell({ instanceHash: 'i', restore: { status: 'failed' } })).toBe(false);
		const p = { ...own('b'), ownImage: { ...own('b').ownImage, previous: own('a') } };
		const patch = releasePrevious(p);
		expect(patch.ownImage.previous).toBeUndefined();
		expect(patch.oldOwnImages).toEqual([h('a')]);
	});
	it('never forgets the image started from, the way back, or one in use', () => {
		const p = { ...own('b'), ownImage: { ...own('b').ownImage, previous: own('a') }, running: { rootfsItemHash: h('c') }, oldOwnImages: [h('a'), h('b'), h('c'), h('d')] };
		expect(forgettable(p)).toEqual([h('d')]);
	});
	it('keeps what could not be forgotten, for the next try', async () => {
		const p = { ...own('b'), oldOwnImages: [h('d'), h('e')] };
		expect(await forgetQueued(p, async (x) => x === h('d'))).toEqual([h('e')]);
		expect(await forgetQueued(p, async () => { throw new Error('down'); })).toEqual([h('d'), h('e')]);
	});
	it('a failed start can go back to the previous image, and keeps the newer one as the way back', () => {
		const p = { ...own('b'), ownImage: { ...own('b').ownImage, previous: own('a') } };
		const back = fallbackPatch(p);
		expect(back.rootfsItemHash).toBe(h('a'));
		expect(back.luksPassphrase).toBe('pass-a');
		expect(back.ownImage.previous.rootfsItemHash).toBe(h('b'));
		expect(fallbackPatch(own('b'))).toBeNull();
	});
});
