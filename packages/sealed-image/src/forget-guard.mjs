// What may be forgotten when a builder is deleted (the workflow
// sealed-image-builder.yml, action "delete" with "forget_volumes"): only the
// STOREs that builder's V-PROGRAM names as its volumes, and never an image.
//
// On 14 Nov 2026 a hand-written list of "builder volumes" forgot older
// Paperless anywhere images too, among them one a vault still started from.
// So a STORE is forgotten only when all of this holds; one refusal stops all
// of it.
// - The V-PROGRAM being deleted names it (workload, volume or a hash tree).
// - The account that sent the V-PROGRAM sent it, and Aleph has it processed.
// - It is smaller than any image: a builder's volumes are about 300 MB at
//   most, a sealed image is about 900 MB to 1 GiB. A plain-image volume
//   larger than the limit is refused, which forgets nothing (safe).
// - The kept list (the pinned builders in builder/publications, an app's
//   pins, release notes) does not name it.

/** Bigger than any builder volume, smaller than any sealed image. */
export const BUILDER_VOLUME_MAX_BYTES = 600 * 1024 * 1024;

/**
 * The refs a V-PROGRAM's content names as its volumes.
 * @param {any} content the V-PROGRAM's content
 * @returns {string[]}
 */
export function volumeRefs(content) {
	const refs = [content?.workload?.ref, content?.workload?.hash_tree, ...(content?.volumes ?? []).flatMap((v) => [v?.ref, v?.hash_tree])];
	return [...new Set(refs.filter((r) => typeof r === 'string' && r.length > 0))];
}

/**
 * Why `store` must not be forgotten, or null when it may.
 * @param {{ hash: string, status?: string, type?: string, sender?: string, size?: number | null }} store
 * @param {{ account: string, named: Set<string>, kept: Set<string> }} o `named`: the STOREs the V-PROGRAM names; `kept`: hashes that must stay (pins, releases)
 */
export function forgetRefusal(store, { account, named, kept }) {
	const h = store.hash;
	if (!/^[0-9a-f]{64}$/.test(h)) return `${h}: no item hash`;
	if (!named.has(h)) return `${h}: not a volume of the builder being deleted`;
	if (kept.has(h)) return `${h}: named in the kept list`;
	if (store.type !== 'STORE' || store.status !== 'processed') return `${h}: not a processed STORE (${store.status} ${store.type})`;
	if (String(store.sender).toLowerCase() !== String(account).toLowerCase()) return `${h}: sent by ${store.sender}, not by ${account}`;
	if (typeof store.size !== 'number' || !(store.size > 0)) return `${h}: size unknown, so it might be an image`;
	if (store.size > BUILDER_VOLUME_MAX_BYTES) return `${h}: ${Math.round(store.size / 1e6)} MB, an image rather than a builder volume`;
	return null;
}

/**
 * The STOREs to forget, or the reasons not to forget any.
 * @param {Parameters<typeof forgetRefusal>[0][]} stores
 * @param {Parameters<typeof forgetRefusal>[1]} o
 * @returns {{ forget: string[], refused: string[] }}
 */
export function builderVolumesToForget(stores, o) {
	const refused = stores.map((s) => forgetRefusal(s, o)).filter((r) => r !== null);
	return refused.length ? { forget: [], refused } : { forget: stores.map((s) => s.hash), refused: [] };
}
