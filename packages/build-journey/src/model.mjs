// The build of a sealed image as one journey in stations, for a view that
// shows it while it runs (BuildJourney.svelte): the steps
// `@le-space/sealed-image` reports (`onProgress({ step, data })`) mapped onto
// stations with typical durations, the facts reported on the way (kept only
// when they look like what they claim), the time left from what is known,
// the small steps of a station, what flows where, and the evidence with
// links to check it. An app may add stations after the build (a VM's start:
// `startStation`). Only the fetch and a start's steps report real progress;
// everything else is an estimate. Pure: no DOM, no network, no clock read
// unless handed in.

/**
 * What the build (and a start after it) reported so far. All optional.
 * @typedef {{
 *   vprogram?: string, node?: string, relay?: string, measurement?: string,
 *   plainSha256?: string, cid?: string, size?: number, got?: number,
 *   lanes?: number, attested?: number, fetchSince?: number, storeHash?: string,
 *   host?: string, attempt?: number, processed?: boolean,
 *   instanceHash?: string, vmStep?: string, vmMeasurement?: string
 * }} Facts
 */

/**
 * What flows where right now: the path (place keys in order), what it
 * carries, and how far it is (0–1) when that is known.
 * @typedef {{ path: string[], what: string, share: number | null }} Flow
 */

/**
 * A station of the journey. The build's five come with their small steps and
 * flows; a station of the app's own brings them as functions.
 * @typedef {{
 *   key: string,
 *   typical: number,
 *   steps?: (f: Facts) => [string, boolean][],
 *   flow?: (f: Facts) => Flow
 * }} Station
 */

/** The typical seconds of the build's stations (measured on Aleph 2026-11-14: builder about 4 min, fetch of about 900 MiB about 9 min). */
export const BUILD_TYPICAL = Object.freeze({ wake: 240, check: 20, seal: 100, fetch: 540, store: 90 });

/**
 * The build's five stations, with other typical seconds where an app knows
 * better (a smaller image, a slower relay).
 * @param {Partial<Record<keyof typeof BUILD_TYPICAL, number>>} [typical]
 * @returns {Station[]}
 */
export function buildStations(typical = {}) {
	return Object.entries(BUILD_TYPICAL).map(([key, s]) => ({
		key,
		typical: positive(/** @type {any} */ (typical)[key]) ?? s
	}));
}

/** The build's stations at their typical times. */
export const BUILD_STATIONS = Object.freeze(buildStations());

/** A start's steps, in order (a VM from the sealed image: measured, placed, reachable, unlocked, ready). */
export const START_STEPS = Object.freeze(['measure', 'instance', 'network', 'unlock', 'ready']);

/**
 * A station after the build: the VM started from the sealed image. Its small
 * steps follow `facts.vmStep` (one of START_STEPS); its flow shows the order
 * for the VM, the VM's report, and at `ready` the restore from `restoreFrom`
 * when given (a place key, e.g. 'filecoin').
 * @param {{ key?: string, typical?: number, restoreFrom?: string | null }} [o]
 * @returns {Station}
 */
export function startStation({ key = 'start', typical = 600, restoreFrom = null } = {}) {
	return {
		key,
		typical,
		steps: (f) =>
			START_STEPS.map((s) => [
				s,
				Boolean(f.vmStep && START_STEPS.indexOf(f.vmStep) > START_STEPS.indexOf(s))
			]),
		flow: (f) =>
			f.vmStep === 'unlock'
				? { path: ['node', 'relay', 'browser'], what: 'vmReport', share: null }
				: f.vmStep === 'ready' && restoreFrom
					? { path: [restoreFrom, 'node'], what: 'backup', share: null }
					: { path: ['browser', 'aleph', 'node'], what: 'instance', share: null }
	};
}

/** A build step (`onProgress({ step })`) as a station, or null. @param {string} step */
export function stationOfBuildStep(step) {
	if (step === 'start') return 'wake';
	if (step === 'attest') return 'check';
	if (step === 'build') return 'seal';
	if (step === 'fetch') return 'fetch';
	if (step === 'sign' || step === 'upload' || step === 'confirm') return 'store';
	return null;
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEXISH = /^[0-9a-f]{32,128}$/i;
const CIDISH = /^[A-Za-z0-9]{40,64}$/;
const RELAY = /^(wss?:\/\/)?[a-z0-9.-]{1,253}(:\d{1,5})?(\/[\w/-]*)?$/i;
const HOST = /^(https?:\/\/)?[a-z0-9.-]{1,253}(:\d{1,5})?\/?$/i;
const COMMIT = /^[0-9a-f]{7,40}$/;

/** @param {unknown} v */
function positive(v) {
	return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/**
 * What was reported so far, merged with one more report: only values that
 * look like what they claim are kept (they are shown, never interpreted).
 * The fetch's start is noted at its first report, for its speed.
 * @param {Facts} facts @param {string} step @param {Record<string, any>} [data] @param {number} [now]
 * @returns {Facts}
 */
export function withFacts(facts, step, data = {}, now = Date.now()) {
	/** @type {Record<string, any>} */
	const out = { ...facts };
	const text = (/** @type {unknown} */ v, /** @type {RegExp} */ re) =>
		typeof v === 'string' && re.test(v) ? v : undefined;
	const set = (/** @type {string} */ k, /** @type {unknown} */ v) => {
		if (v !== undefined) out[k] = v;
	};
	const d = data ?? {};
	set('vprogram', text(d.vprogram, HEX64));
	set('node', text(d.node, HEX64));
	set('relay', text(d.relay, RELAY));
	set('measurement', text(d.measurement, HEXISH));
	set('plainSha256', text(d.plainSha256, HEX64));
	set('cid', text(d.cid, CIDISH));
	set('storeHash', text(d.storeHash, HEX64));
	set('host', text(d.host, HOST));
	set('instanceHash', text(d.instanceHash, HEX64));
	set('vmMeasurement', text(d.vmMeasurement, HEXISH));
	set('vmStep', START_STEPS.includes(d.vmStep) ? d.vmStep : undefined);
	for (const k of ['size', 'got', 'lanes', 'attested', 'attempt']) set(k, positive(d[k]));
	if (d.processed === true) out.processed = true;
	if (step === 'fetch' && out.fetchSince == null) out.fetchSince = now;
	return out;
}

/** The share of the fetch done, 0–100, or null. @param {Facts} f */
export function fetchPercent(f) {
	return f.size && f.got != null ? Math.min(100, Math.round((f.got / f.size) * 100)) : null;
}

/** MiB/s since the fetch began, or null. @param {Facts} f @param {number} now */
export function fetchRate(f, now) {
	if (f.fetchSince == null || !f.got) return null;
	const s = (now - f.fetchSince) / 1000;
	return s > 2 ? f.got / 1048576 / s : null;
}

/** @param {Station[]} stations @param {string} key */
const indexOf = (stations, key) => stations.findIndex((s) => s.key === key);

/**
 * Where the journey stands: the station's index, the share done, the seconds
 * left and when it is expected to end. The fetch counts by its bytes (or
 * `fetchPct` when only a percentage is known) and, once measured, its speed;
 * the others count their typical time down, and an overrun keeps a minute in
 * hand instead of saying "0".
 * @param {{ stations?: Station[], station: string, since: number, now: number, facts?: Facts, fetchPct?: number | null, done?: boolean }} a
 */
export function journey({ stations = BUILD_STATIONS, station, since, now, facts = {}, fetchPct = null, done = false }) {
	const total = stations.reduce((a, s) => a + s.typical, 0);
	if (done) return { index: stations.length, share: 1, left: 0, ends: now, total };
	const index = Math.max(0, indexOf(stations, station));
	const here = stations[index];
	const inStation = Math.max(0, (now - since) / 1000);
	const pct = here.key === 'fetch' ? (fetchPercent(facts) ?? fetchPct) : null;
	const doneHere = pct != null ? (here.typical * pct) / 100 : Math.min(inStation, here.typical * 0.95);
	const rate = here.key === 'fetch' ? fetchRate(facts, now) : null;
	const measured = rate && facts.size && facts.got != null ? (facts.size - facts.got) / 1048576 / rate : null;
	const before = stations.slice(0, index).reduce((a, s) => a + s.typical, 0);
	const after = stations.slice(index + 1).reduce((a, s) => a + s.typical, 0);
	const left = Math.max(60, (measured ?? here.typical - doneHere) + after);
	return {
		index,
		share: total ? Math.min(0.99, (before + doneHere) / total) : 0,
		left,
		ends: now + left * 1000,
		total
	};
}

/** @type {Record<string, (f: Facts) => [string, boolean][]>} */
const BUILD_STEPS = {
	wake: (f) => [
		['ask', Boolean(f.vprogram)],
		['boot', Boolean(f.relay || f.measurement)],
		['answer', Boolean(f.relay || f.measurement)]
	],
	check: (f) => [
		['relay', Boolean(f.relay)],
		['report', Boolean(f.measurement)],
		['match', Boolean(f.measurement)]
	],
	seal: (f) => [
		['send', Boolean(f.plainSha256 || f.cid)],
		['verify', Boolean(f.cid)],
		['luks', Boolean(f.cid)]
	],
	fetch: (f) => [
		['lanes', Boolean(f.attested)],
		['bytes', Boolean(f.size && f.got != null && f.got >= f.size)]
	],
	store: (f) => [
		['sign', Boolean(f.storeHash)],
		['upload', Boolean(f.processed)],
		['confirm', Boolean(f.processed)]
	]
};

/**
 * The small steps of a station, each 'done', 'active' (blinking) or 'next':
 * done when a report says so or the journey is past the station; the first
 * step not done of the current station is the active one.
 * @param {{ stations?: Station[], station: string, current?: string, facts?: Facts, done?: boolean }} a
 * @returns {{ key: string, state: 'done' | 'active' | 'next' }[]}
 */
export function substeps({ stations = BUILD_STATIONS, station, current = station, facts = {}, done = false }) {
	const s = stations.find((x) => x.key === station);
	const rows = (s?.steps ?? BUILD_STEPS[station])?.(facts) ?? [];
	const past = done || indexOf(stations, current) > indexOf(stations, station);
	let active = false;
	return rows.map(([key, ok]) => {
		if (past || ok) return { key, state: /** @type {const} */ ('done') };
		if (station === current && !active) {
			active = true;
			return { key, state: /** @type {const} */ ('active') };
		}
		return { key, state: /** @type {const} */ ('next') };
	});
}

/**
 * What flows where right now, for the picture.
 * @param {{ stations?: Station[], station: string, facts?: Facts, fetchPct?: number | null }} a
 * @returns {Flow}
 */
export function flowNow({ stations = BUILD_STATIONS, station, facts = {}, fetchPct = null }) {
	const own = stations.find((x) => x.key === station)?.flow;
	if (own) return own(facts);
	if (station === 'wake') return { path: ['browser', 'aleph', 'node'], what: 'program', share: null };
	if (station === 'check') return { path: ['node', 'relay', 'browser'], what: 'report', share: null };
	if (station === 'seal') return { path: ['browser', 'relay', 'node'], what: 'passphrase', share: null };
	if (station === 'fetch') {
		const pct = fetchPercent(facts) ?? fetchPct;
		return { path: ['node', 'relay', 'browser'], what: 'pieces', share: pct == null ? null : pct / 100 };
	}
	return { path: ['browser', 'aleph'], what: 'image', share: facts.processed ? 1 : null };
}

/**
 * What an app pins of its builder, as `@le-space/sealed-image` takes it: the
 * plain image (SHA-256, its STORE on Aleph, the commit it was built from),
 * the measurements the hardware must show, and the node.
 * @typedef {{ plain?: { sha256?: string, store?: string, commit?: string }, measurements?: string[], crn?: string } | null | undefined} BuilderPin
 */

/**
 * Where evidence can be checked: `aleph` the base of a message by its hash
 * (`${aleph}/${hash}`), `repo` the source repository of the plain image
 * (`${repo}/commit/${commit}`), `expected` where the app pins the expected
 * measurement.
 * @typedef {{ aleph?: string | null, repo?: string | null, expected?: string | null }} EvidenceLinks
 */

/**
 * @typedef {{ key: string, value: string, href: string | null, ok?: boolean }} Evidence
 */

/**
 * The evidence gathered so far, each with its value and a link to where it
 * can be checked. Only values that look like what they claim are shown, and
 * only those become links. `ok` on the measurement: it is one the app pins.
 * @param {Facts} f @param {BuilderPin} builder @param {EvidenceLinks} [at]
 * @returns {Evidence[]}
 */
export function evidence(f, builder, at = {}) {
	/** @type {Evidence[]} */
	const rows = [];
	const msg = (/** @type {string | undefined} */ h) => (at.aleph && h && HEX64.test(h) ? `${at.aleph}/${h}` : null);
	const commit = builder?.plain?.commit;
	if (commit && COMMIT.test(commit))
		rows.push({ key: 'commit', value: commit, href: at.repo ? `${at.repo}/commit/${commit}` : null });
	const plain = builder?.plain?.sha256 ?? f.plainSha256;
	if (plain && HEX64.test(plain)) rows.push({ key: 'plain', value: plain, href: msg(builder?.plain?.store) });
	const expected = builder?.measurements?.find((m) => HEXISH.test(m));
	if (expected) rows.push({ key: 'expected', value: expected, href: at.expected ?? null });
	if (f.vprogram) rows.push({ key: 'vprogram', value: f.vprogram, href: msg(f.vprogram) });
	const node = f.node ?? builder?.crn;
	if (node && HEX64.test(node)) rows.push({ key: 'node', value: node, href: null });
	if (f.relay && RELAY.test(f.relay)) rows.push({ key: 'relay', value: f.relay.replace(/^wss?:\/\//, ''), href: null });
	if (f.measurement && HEXISH.test(f.measurement))
		rows.push({
			key: 'measured',
			value: f.measurement,
			href: null,
			ok: !builder?.measurements?.length || builder.measurements.includes(f.measurement)
		});
	if (f.cid && CIDISH.test(f.cid)) rows.push({ key: 'cid', value: f.cid, href: null });
	if (f.storeHash) rows.push({ key: 'store', value: f.storeHash, href: msg(f.storeHash), ...(f.processed ? { ok: true } : {}) });
	if (f.instanceHash) rows.push({ key: 'instance', value: f.instanceHash, href: msg(f.instanceHash) });
	if (f.vmMeasurement && HEXISH.test(f.vmMeasurement)) rows.push({ key: 'vmMeasured', value: f.vmMeasurement, href: null, ok: true });
	return rows;
}

/** Evidence the build itself reported (not what the app pins): shown once there is any. @param {Evidence[]} rows */
export const reported = (rows) => rows.filter((r) => !['commit', 'plain', 'expected', 'node'].includes(r.key));

/** The hardware the checks rest on, with the makers' pages. */
export const HARDWARE = Object.freeze([
	Object.freeze({ key: 'sev', href: 'https://www.amd.com/en/developer/sev.html' }),
	Object.freeze({ key: 'epyc', href: 'https://www.amd.com/en/products/processors/server/epyc.html' })
]);

/** The places of the flow picture and where they sit (viewBox 720×250). */
export const PLACES = Object.freeze({
	browser: Object.freeze(/** @type {[number, number]} */ ([100, 120])),
	relay: Object.freeze(/** @type {[number, number]} */ ([360, 44])),
	node: Object.freeze(/** @type {[number, number]} */ ([620, 120])),
	aleph: Object.freeze(/** @type {[number, number]} */ ([360, 196]))
});

/** The lines between the places. */
export const LINKS = Object.freeze([
	['browser', 'relay'],
	['relay', 'node'],
	['browser', 'aleph'],
	['aleph', 'node']
]);

/** The SVG path through the places, for the moving packets. @param {string[]} path @param {Record<string, readonly number[]>} at */
export function pathOf(path, at) {
	return path
		.filter((p) => at[p])
		.map((p, i) => `${i ? 'L' : 'M'}${at[p][0]} ${at[p][1]}`)
		.join(' ');
}

/** Whether a line between two places is on the path. @param {string[]} path @param {string} a @param {string} b */
export function onPath(path, a, b) {
	return path.some((p, i) => i > 0 && ((path[i - 1] === a && p === b) || (path[i - 1] === b && p === a)));
}

/** A long hash, shortened for the eye. @param {string} v */
export const short = (v) => (v.length > 20 ? `${v.slice(0, 10)}…${v.slice(-6)}` : v);

/** Whole minutes, at least one. @param {number} s */
export const minutes = (s) => Math.max(1, Math.round(s / 60));
