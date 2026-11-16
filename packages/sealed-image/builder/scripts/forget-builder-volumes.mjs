// The volumes of one builder that may be forgotten with it
// (sealed-image-builder-publish.yml, "delete" with "forget_volumes"). Prints their item
// hashes, one per line; prints why not and exits 1 when any is refused, so
// nothing is forgotten. The rules are in ../../src/forget-guard.mjs.
//
// Usage: node builder/scripts/forget-builder-volumes.mjs <V-PROGRAM item hash> <file with kept hashes>
import { readFileSync } from 'node:fs';
import { builderVolumesToForget, volumeRefs } from '../../src/forget-guard.mjs';

const API = process.env.ALEPH_API ?? 'https://api2.aleph.im';
const [vprogram, keptFile] = process.argv.slice(2);
if (!/^[0-9a-f]{64}$/.test(vprogram ?? '')) throw new Error('usage: forget-builder-volumes.mjs <V-PROGRAM item hash> <kept hashes file>');

const get = async (path) => {
	for (let i = 0; ; i++) {
		const res = await fetch(`${API}${path}`);
		if (res.ok || res.status === 404) return res.ok ? res.json() : null;
		if (i >= 2) throw new Error(`${path}: HTTP ${res.status}`);
		await new Promise((r) => setTimeout(r, 3000));
	}
};

const vp = await get(`/api/v0/messages/${vprogram}`);
if (vp?.status !== 'processed' || !['PROGRAM', 'V-PROGRAM'].includes(vp.message?.type)) throw new Error(`${vprogram} is no processed V-PROGRAM (${vp?.status} ${vp?.message?.type})`);
const account = vp.message.sender;
const content = vp.message.content ?? JSON.parse(vp.message.item_content);
const kept = new Set((keptFile ? readFileSync(keptFile, 'utf8') : '').match(/[0-9a-f]{64}/g) ?? []);

// A ref is a STORE's item hash, or the file's hash: then the account's STOREs of that file.
const named = new Set();
for (const ref of volumeRefs(content)) {
	if (/^[0-9a-f]{64}$/.test(ref)) {
		const m = await get(`/api/v0/messages/${ref}`);
		if (m?.message?.type === 'STORE' && m.message.sender === account) named.add(ref);
	}
	const by = await get(`/api/v0/messages.json?addresses=${account}&msgTypes=STORE&contentHashes=${ref}`);
	for (const m of by?.messages ?? []) named.add(m.item_hash);
}

const sizes = new Map();
for (let page = 1; ; page++) {
	const f = await get(`/api/v0/addresses/${account}/files?pagination=200&page=${page}`);
	for (const x of f?.files ?? []) sizes.set(x.item_hash, x.size);
	if (!f?.files?.length || page * 200 >= (f.pagination_total ?? 0)) break;
}

const stores = [];
for (const hash of named) {
	const m = await get(`/api/v0/messages/${hash}`);
	stores.push({ hash, status: m?.status, type: m?.message?.type, sender: m?.message?.sender, size: sizes.get(hash) ?? null });
}
const { forget, refused } = builderVolumesToForget(stores, { account, named, kept });
if (refused.length) {
	for (const r of refused) console.error(`refused: ${r}`);
	process.exit(1);
}
for (const h of forget) console.log(h);
