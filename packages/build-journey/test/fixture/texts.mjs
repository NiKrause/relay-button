// Made-up English words for the scenario: every key the view asks for.
// Missing keys are collected, so the test sees a key the README lacks.
const station = (label, duration, title) => ({ label, duration, title, text: `${title}.`, mini: title });
export const EN = {
	kicker: 'Your own image',
	title: 'Your image is being made',
	minimize: 'Minimise',
	expand: 'Show',
	close: 'Close',
	step: 'Step {n} of {of}',
	stoppedAt: 'Stopped at step {n} · {station}',
	failedTitle: 'The build stopped',
	failedText: 'You can try again.',
	stations: {
		wake: station('Builder', 'about 4 min', 'Your builder is waking up'),
		check: station('Genuine', 'a few seconds', 'Confirmed genuine'),
		seal: station('Seal', 'about 2 min', 'Your image is being sealed'),
		fetch: station('Fetch', 'about 9 min', 'Your image is on its way'),
		store: station('Stored', 'about 1 min', 'Safely stored'),
		start: station('Start', 'about 10 min', 'Your VM is waking up')
	},
	sub: {
		ask: 'Builder requested', boot: 'Node starts the builder', answer: 'Builder answers',
		relay: 'Relay connected', report: 'Report received', match: 'Measurement matches',
		send: 'Passphrase sent', verify: 'Base image checked', luks: 'Sealed with LUKS',
		lanes: 'Connections confirmed', bytes: 'Pieces arriving',
		sign: 'STORE signed', upload: 'Uploaded', confirm: 'Confirmed',
		measure: 'Measured', instance: 'Placed', network: 'Network', unlock: 'Unlocked', ready: 'Ready'
	},
	attested: '{count} confirmed',
	mib: '{got} of {size} MiB',
	rate: '{rate} MiB/s',
	attempt: 'try {n} of {of}',
	retryNote: 'Uploading again.',
	fetched: '{pct} % fetched',
	flowTitle: 'Flowing now',
	flow: {
		program: 'order', report: 'report', passphrase: 'passphrase', pieces: 'pieces', image: 'image',
		instance: 'VM order', vmReport: 'VM report', backup: 'backup'
	},
	places: { browser: 'Your browser', relay: 'Relay', node: 'Confidential node', aleph: 'Aleph', filecoin: 'Filecoin' },
	evidenceTitle: 'Evidence',
	evidence: {
		commit: 'Source at', plain: 'Base image (SHA-256)', expected: 'Expected measurement', vprogram: 'Builder (V-PROGRAM)',
		node: 'Node', relay: 'Relay', measured: 'Measured by the AMD processor', cid: 'Content address',
		store: 'On Aleph (STORE)', instance: 'Your VM', vmMeasured: 'VM measurement'
	},
	matches: 'matches',
	evidenceNone: 'Nothing measured yet.',
	evidenceNoneStopped: 'Nothing to show.',
	hardwareTitle: 'The hardware behind it',
	hardware: { sev: 'AMD SEV-SNP', epyc: 'AMD EPYC' },
	share: '{pct} % done',
	left: 'about {minutes} min to go',
	endsAt: 'ready around {time}',
	keepOpen: 'Leave this window open.',
	cameBack: 'The page was away for {seconds} s.',
	tab: '{pct} % · Image',
	leave: 'Leaving stops the build.',
	doneTitle: 'Done',
	doneText: 'Your image is stored.',
	open: 'Open',
	showCertificate: 'Certificate'
};

/** @param {string[]} missing */
export function textOf(missing, words = EN) {
	return (/** @type {string} */ key, /** @type {Record<string, any>} */ vars = {}) => {
		let v = /** @type {any} */ (words);
		for (const part of key.split('.')) v = v?.[part];
		if (typeof v !== 'string') {
			missing.push(key);
			return key;
		}
		return v.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`));
	};
}
