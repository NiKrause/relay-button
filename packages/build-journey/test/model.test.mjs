import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	BUILD_STATIONS,
	buildStations,
	evidence,
	fetchPercent,
	fetchRate,
	flowNow,
	journey,
	marksNow,
	onPath,
	pathOf,
	PLACES,
	reported,
	short,
	startStation,
	stationOfBuildStep,
	substeps,
	withFacts
} from '../src/index.mjs';

const H = (c) => c.repeat(64);
const MEASURE = 'ab'.repeat(48);
const MIB = 1048576;

test('the build steps map onto five stations, others onto none', () => {
	assert.deepEqual(
		['start', 'attest', 'build', 'fetch', 'sign', 'upload', 'confirm', 'other'].map(stationOfBuildStep),
		['wake', 'check', 'seal', 'fetch', 'store', 'store', 'store', null]
	);
	assert.deepEqual(BUILD_STATIONS.map((s) => s.key), ['wake', 'check', 'seal', 'fetch', 'store']);
});

test('an app may give its own typical seconds and add a start station', () => {
	const s = [...buildStations({ store: 60, fetch: -1 }), startStation({ key: 'paperless', typical: 600 })];
	assert.equal(s.find((x) => x.key === 'store')?.typical, 60);
	assert.equal(s.find((x) => x.key === 'fetch')?.typical, 540, 'a negative time is ignored');
	assert.equal(s.at(-1)?.key, 'paperless');
});

test('withFacts keeps only values that look like what they claim', () => {
	let f = withFacts({}, 'start', { vprogram: H('a'), node: 'nope' });
	f = withFacts(f, 'attest', { relay: 'wss://relay.example.com/attest', measurement: MEASURE });
	f = withFacts(f, 'build', { plainSha256: H('b'), cid: 'bafy'.padEnd(59, 'x'), size: 10 * MIB });
	f = withFacts(f, 'fetch', { got: MIB, size: 10 * MIB, attested: 3, evil: '<script>' }, 1000);
	f = withFacts(f, 'fetch', { got: 2 * MIB }, 5000);
	f = withFacts(f, 'upload', { host: 'https://api2.aleph.im', attempt: 2 });
	f = withFacts(f, 'confirm', { storeHash: H('c'), processed: true, measurement: 'javascript:alert(1)' });
	assert.equal(f.vprogram, H('a'));
	assert.equal(f.node, undefined);
	assert.equal(f.measurement, MEASURE, 'a bad value does not overwrite a good one');
	assert.equal(f.fetchSince, 1000, 'the fetch started at its first report');
	assert.equal(f.got, 2 * MIB);
	assert.equal(f.attempt, 2);
	assert.equal(f.processed, true);
	assert.equal(/** @type {any} */ (f).evil, undefined);
	assert.equal(withFacts({}, 'x', { relay: 'wss://bad host' }).relay, undefined);
	assert.equal(withFacts({}, 'x', { vmStep: 'unlock' }).vmStep, 'unlock');
	assert.equal(withFacts({}, 'x', { vmStep: 'whatever' }).vmStep, undefined);
	assert.deepEqual(withFacts({}, 'x', null), {});
});

test('fetch percent and rate', () => {
	assert.equal(fetchPercent({}), null);
	assert.equal(fetchPercent({ size: 100, got: 42 }), 42);
	assert.equal(fetchPercent({ size: 100, got: 420 }), 100);
	assert.equal(fetchRate({ fetchSince: 0, got: 10 * MIB }, 1000), null, 'too early to say');
	assert.equal(fetchRate({ fetchSince: 0, got: 10 * MIB }, 10_000), 1);
});

test('journey: share, time left with a minute in hand, done', () => {
	const total = BUILD_STATIONS.reduce((a, s) => a + s.typical, 0);
	const start = journey({ station: 'wake', since: 0, now: 0 });
	assert.equal(start.index, 0);
	assert.equal(start.share, 0);
	assert.equal(start.left, total);
	const late = journey({ station: 'check', since: 0, now: 3_600_000 });
	assert.ok(late.left >= 60, 'an overrun keeps a minute');
	const done = journey({ station: 'store', since: 0, now: 5, done: true });
	assert.deepEqual([done.index, done.share, done.left, done.ends], [5, 1, 0, 5]);
	const unknown = journey({ station: 'nowhere', since: 0, now: 0 });
	assert.equal(unknown.index, 0);
});

test('journey: the fetch counts by bytes, then by its measured speed', () => {
	const f = { size: 100 * MIB, got: 50 * MIB, fetchSince: 0 };
	const j = journey({ station: 'fetch', since: 0, now: 50_000, facts: f });
	// 1 MiB/s measured, 50 MiB left = 50 s, plus the store's 90 s.
	assert.equal(j.left, 140);
	const byPct = journey({ station: 'fetch', since: 0, now: 0, fetchPct: 50 });
	const before = 240 + 20 + 100;
	assert.equal(byPct.share, (before + 270) / byPct.total);
});

test('journey with a start station counts it too', () => {
	const stations = [...BUILD_STATIONS, startStation({ key: 'paperless', typical: 600 })];
	const j = journey({ stations, station: 'paperless', since: 0, now: 0 });
	assert.equal(j.index, 5);
	assert.equal(j.left, 600);
});

test('substeps: done by report or by being past, the first open one active', () => {
	assert.deepEqual(
		substeps({ station: 'check', facts: { relay: 'r.example.com' } }).map((s) => s.state),
		['done', 'active', 'next']
	);
	assert.deepEqual(
		substeps({ station: 'seal', current: 'fetch', facts: {} }).map((s) => s.state),
		['done', 'done', 'done'],
		'a station behind is done'
	);
	assert.deepEqual(
		substeps({ station: 'store', current: 'wake', facts: {} }).map((s) => s.state),
		['next', 'next', 'next'],
		'a station ahead has nothing active'
	);
	assert.deepEqual(substeps({ station: 'seal', facts: {} }).map((s) => s.key), ['send', 'verify', 'luks']);
	assert.deepEqual(substeps({ station: 'fetch', facts: {}, done: true }).map((s) => s.state), ['done', 'done']);
	const stations = [...BUILD_STATIONS, startStation({ key: 'paperless' })];
	assert.deepEqual(
		substeps({ stations, station: 'paperless', facts: { vmStep: 'network' } }).map((s) => s.state),
		['done', 'done', 'active', 'next', 'next']
	);
	assert.deepEqual(substeps({ station: 'nowhere' }), []);
});

test('flowNow: the path of each station, the fetch with its share', () => {
	assert.deepEqual(flowNow({ station: 'wake' }), { path: ['browser', 'aleph', 'node'], what: 'program', share: null, kind: 'data' });
	assert.equal(flowNow({ station: 'check' }).kind, 'report');
	assert.equal(flowNow({ station: 'seal' }).kind, 'key');
	assert.equal(flowNow({ station: 'check' }).what, 'report');
	assert.equal(flowNow({ station: 'seal' }).what, 'passphrase');
	assert.equal(flowNow({ station: 'fetch', facts: { size: 4, got: 1 } }).share, 0.25);
	assert.equal(flowNow({ station: 'fetch', fetchPct: 50 }).share, 0.5);
	assert.equal(flowNow({ station: 'store', facts: { processed: true } }).share, 1);
	const stations = [...BUILD_STATIONS, startStation({ key: 'paperless', restoreFrom: 'filecoin' })];
	assert.equal(flowNow({ stations, station: 'paperless' }).what, 'instance');
	assert.equal(flowNow({ stations, station: 'paperless', facts: { vmStep: 'unlock' } }).what, 'vmReport');
	assert.deepEqual(flowNow({ stations, station: 'paperless', facts: { vmStep: 'ready' } }).path, ['filecoin', 'node']);
	assert.deepEqual(flowNow({ stations, station: 'paperless', facts: { vmStep: 'unlock', vmMeasurement: MEASURE } }), {
		path: ['browser', 'relay', 'node'], what: 'unlockKey', share: null, kind: 'key'
	});
	const noRestore = [...BUILD_STATIONS, startStation()];
	assert.equal(flowNow({ stations: noRestore, station: 'start', facts: { vmStep: 'ready' } }).what, 'instance');
});

const BUILDER = {
	plain: { sha256: H('1'), store: H('2'), commit: '0123abc' },
	measurements: [MEASURE],
	crn: H('3')
};
const AT = {
	aleph: 'https://api2.aleph.im/api/v0/messages',
	repo: 'https://github.com/example/app',
	expected: 'https://github.com/example/app/blob/main/pins.js'
};

test('evidence: the pins first, then what the build reported, with links', () => {
	const pins = evidence({}, BUILDER, AT);
	assert.deepEqual(pins.map((r) => r.key), ['commit', 'plain', 'expected', 'node']);
	assert.equal(pins[0].href, `${AT.repo}/commit/0123abc`);
	assert.equal(pins[1].href, `${AT.aleph}/${H('2')}`);
	assert.equal(pins[2].href, AT.expected);
	assert.deepEqual(reported(pins), []);
	const f = {
		vprogram: H('4'),
		relay: 'wss://relay.example.com/attest',
		measurement: MEASURE,
		cid: 'b'.repeat(59),
		storeHash: H('5'),
		processed: true
	};
	const all = evidence(f, BUILDER, AT);
	assert.deepEqual(reported(all).map((r) => r.key), ['vprogram', 'relay', 'measured', 'cid', 'store']);
	assert.equal(all.find((r) => r.key === 'measured')?.ok, true, 'the measurement is a pinned one: "matches"');
	assert.equal(all.find((r) => r.key === 'relay')?.value, 'relay.example.com/attest');
	assert.equal(all.find((r) => r.key === 'store')?.href, `${AT.aleph}/${H('5')}`);
	const other = evidence({ measurement: 'cd'.repeat(48) }, BUILDER, AT);
	assert.equal(other.find((r) => r.key === 'measured')?.ok, false);
});

test('evidence without pins or link bases: no links, the plain hash from the build', () => {
	const rows = evidence({ plainSha256: H('6'), vprogram: H('7'), node: H('8') }, null);
	assert.deepEqual(rows.map((r) => [r.key, r.href]), [
		['plain', null],
		['vprogram', null],
		['node', null]
	]);
	assert.deepEqual(evidence({ vprogram: 'not-a-hash' }, { plain: { commit: 'javascript:x' } }, AT).map((r) => r.href), [null]);
});

test('the picture: path and lines', () => {
	assert.equal(pathOf(['browser', 'relay'], PLACES), 'M100 120 L360 44');
	assert.equal(pathOf(['browser', 'mars'], PLACES), 'M100 120');
	assert.equal(onPath(['node', 'relay', 'browser'], 'browser', 'relay'), true);
	assert.equal(onPath(['node', 'relay', 'browser'], 'browser', 'aleph'), false);
	assert.equal(short('x'.repeat(30)), `${'x'.repeat(10)}…${'x'.repeat(6)}`);
});

test('marksNow: keys, checks and measurements where they happened', () => {
	const pin = { measurements: [MEASURE] };
	const brief = (marks) => marks.map((m) => `${m.at}:${m.kind}:${m.now ? 'now' : m.ok === false ? 'bad' : m.ok ? 'ok' : 'done'}`);
	assert.deepEqual(marksNow({ station: 'wake' }), []);
	assert.deepEqual(brief(marksNow({ station: 'check', builder: pin })), ['node:measure:now']);
	assert.deepEqual(brief(marksNow({ station: 'seal', facts: { measurement: MEASURE }, builder: pin })), [
		'node:measure:ok', 'browser:attest:ok', 'node:key:now'
	]);
	const wrong = marksNow({ station: 'seal', facts: { measurement: 'cd'.repeat(48) }, builder: pin });
	assert.equal(wrong.find((m) => m.kind === 'attest')?.label, 'marks.mismatch');
	assert.deepEqual(brief(wrong).slice(0, 2), ['node:measure:bad', 'browser:attest:bad']);
	const fetching = marksNow({ station: 'fetch', facts: { measurement: MEASURE, cid: 'b'.repeat(59), attested: 21 }, builder: pin });
	assert.deepEqual(brief(fetching), ['node:measure:ok', 'node:key:done', 'browser:attest:now']);
	assert.deepEqual(fetching.find((m) => m.kind === 'attest')?.vars, { count: 21 });
	assert.deepEqual(brief(marksNow({ station: 'store', facts: { cid: 'b'.repeat(59) } })), ['node:key:done', 'browser:sign:now']);
	const stored = marksNow({ station: 'store', done: true, facts: { measurement: MEASURE, cid: 'b'.repeat(59), storeHash: H('5'), processed: true } });
	assert.deepEqual(brief(stored), ['node:measure:ok', 'browser:attest:ok', 'node:key:done', 'browser:sign:done', 'aleph:store:ok']);
	const stations = [...BUILD_STATIONS, startStation()];
	const f = { measurement: MEASURE, cid: 'b'.repeat(59), storeHash: H('5'), processed: true, vmStep: 'unlock' };
	assert.equal(marksNow({ stations, station: 'start', facts: f }).find((m) => m.at === 'node' && m.kind === 'measure')?.label, 'marks.vmMeasuring');
	const unlocking = marksNow({ stations, station: 'start', facts: { ...f, vmMeasurement: MEASURE } });
	assert.equal(unlocking.find((m) => m.at === 'node' && m.kind === 'key')?.label, 'marks.unlocking');
	assert.equal(unlocking.find((m) => m.at === 'browser' && m.kind === 'attest')?.label, 'marks.vmAttested');
	const ready = marksNow({ stations, station: 'start', facts: { ...f, vmMeasurement: MEASURE, vmStep: 'ready' } });
	assert.equal(ready.find((m) => m.at === 'node' && m.kind === 'key')?.label, 'marks.unlocked');
});
