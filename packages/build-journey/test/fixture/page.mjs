// The scenario page: mounts the view in one of a few states, with made-up
// pins and facts, and notes the callbacks it gets.
import { mount, unmount, createRawSnippet } from 'svelte';
import BuildJourney from '../../src/BuildJourney.svelte';
import { BUILD_STATIONS, startStation, withFacts } from '../../src/index.mjs';
import { textOf } from './texts.mjs';

const H = (c) => c.repeat(64);
const MIB = 1048576;
const BUILDER = { plain: { sha256: H('1'), store: H('2'), commit: '0123abcd' }, measurements: ['ab'.repeat(48)], crn: H('3') };
const LINKS = { aleph: 'https://aleph.example.com/messages', repo: 'https://example.com/app', expected: 'https://example.com/app/pins.js' };

/** The facts of a build that got as far as `upto`. */
function factsUpTo(upto, now) {
	const order = ['start', 'attest', 'build', 'fetch', 'upload', 'confirm'];
	/** @type {Record<string, any>} */
	const data = {
		start: { vprogram: H('4'), node: H('3') },
		attest: { relay: 'wss://relay.example.com/attest', measurement: 'ab'.repeat(48) },
		build: { plainSha256: H('1'), cid: 'b'.repeat(59), size: 900 * MIB },
		fetch: { got: 450 * MIB, size: 900 * MIB, attested: 21 },
		upload: { host: 'https://api.example.com', attempt: 2, storeHash: H('5') },
		confirm: { storeHash: H('5'), processed: true }
	};
	let f = {};
	for (const step of order.slice(0, order.indexOf(upto) + 1))
		f = withFacts(f, step, data[step], step === 'fetch' ? now - 450_000 : now);
	return f;
}

const STATES = {
	fetch: () => ({ view: { station: 'fetch', since: Date.now() - 60_000, done: false, failed: false, minimized: false, facts: factsUpTo('fetch', Date.now()) } }),
	store: () => ({ view: { station: 'store', since: Date.now(), done: false, failed: false, facts: factsUpTo('upload', Date.now()) }, uploadHosts: 3 }),
	check: () => ({ view: { station: 'check', since: Date.now(), done: false, failed: false, facts: factsUpTo('start', Date.now()) } }),
	seal: () => ({ view: { station: 'seal', since: Date.now(), done: false, failed: false, facts: factsUpTo('attest', Date.now()) } }),
	wrong: () => ({ view: { station: 'seal', since: Date.now(), done: false, failed: false, facts: factsUpTo('attest', Date.now()) }, builder: { ...BUILDER, measurements: ['cd'.repeat(48)] } }),
	unlock: () => ({
		view: { station: 'start', since: Date.now(), done: false, failed: false, facts: { ...factsUpTo('confirm', Date.now()), vmStep: 'unlock', vmMeasurement: 'ef'.repeat(48) } },
		stations: [...BUILD_STATIONS, startStation({ key: 'start', restoreFrom: 'filecoin' })],
		places: { browser: [100, 120], relay: [360, 44], node: [620, 120], aleph: [360, 196], filecoin: [620, 216] },
		lines: [['browser', 'relay'], ['relay', 'node'], ['browser', 'aleph'], ['aleph', 'node'], ['filecoin', 'node']]
	}),
	wake: () => ({ view: { station: 'wake', since: Date.now(), done: false, failed: false, facts: {} }, hint: 'On a phone: stay here.' }),
	stopped: () => ({ view: { station: 'check', since: Date.now(), done: false, failed: true, facts: {} }, reason: 'The builder did not answer.' }),
	done: () => ({ view: { station: 'store', since: Date.now(), done: true, failed: false, facts: factsUpTo('confirm', Date.now()) }, openHref: 'https://example.com/open', oncertificate: () => calls.push('certificate') }),
	mini: () => ({ view: { station: 'seal', since: Date.now(), done: false, failed: false, minimized: true, facts: factsUpTo('build', Date.now()) } }),
	start: () => ({
		view: { station: 'start', since: Date.now(), done: false, failed: false, facts: { ...factsUpTo('confirm', Date.now()), vmStep: 'unlock' } },
		stations: [...BUILD_STATIONS, startStation({ key: 'start', restoreFrom: 'filecoin' })],
		places: { browser: [100, 120], relay: [360, 44], node: [620, 120], aleph: [360, 196], filecoin: [620, 216] },
		lines: [['browser', 'relay'], ['relay', 'node'], ['browser', 'aleph'], ['aleph', 'node'], ['filecoin', 'node']],
		miniAt: 'top'
	}),
	// An app without some words and without the finale's evidence (Paperless anywhere).
	quietDone: () => ({ view: { station: 'store', since: Date.now(), done: true, failed: false, facts: factsUpTo('confirm', Date.now()) }, finaleEvidence: false }),
	quietWake: () => ({ view: { station: 'wake', since: Date.now(), done: false, failed: false, facts: {} }, text: (k, v) => (k === 'evidenceNone' ? '' : textOf(missing)(k, v)) }),
	cover: () => ({ view: { station: 'store', since: Date.now(), done: true, failed: false, facts: {} }, cover: createRawSnippet(() => ({ render: () => '<p data-testid="cover">certificate</p>' })) })
};

/** @type {string[]} */
const calls = [];
/** @type {string[]} */
const missing = [];
/** @type {any} */
let shown = null;
const w = /** @type {any} */ (window);
w.calls = calls;
w.missing = missing;
w.show = (/** @type {keyof typeof STATES} */ name) => {
	if (shown) unmount(shown);
	document.title = 'scenario';
	shown = mount(BuildJourney, {
		target: document.body,
		props: {
			text: textOf(missing),
			locale: 'en-GB',
			builder: BUILDER,
			links: LINKS,
			onminimize: () => calls.push('minimize'),
			onexpand: () => calls.push('expand'),
			onclose: () => calls.push('close'),
			...STATES[name]()
		}
	});
};
w.ready = true;
