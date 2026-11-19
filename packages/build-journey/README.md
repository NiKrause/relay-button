# @le-space/build-journey

The build of a sealed image ([`@le-space/sealed-image`](../sealed-image)) as a
journey in stations, for the full-screen view an app shows while it runs: a
pure model and a Svelte 5 component. Paperless anywhere (its first start) and
the Belege bridge (its own image) show the same view with their own words.

```
 1 Builder ── 2 Genuine ── 3 Seal ── 4 Fetch ── 5 Stored ( ── 6 an app's start)
```

## Model (`@le-space/build-journey`)

Plain ES modules, no DOM, no network; runs in a browser and in Node.

- `BUILD_STATIONS`, `buildStations({ fetch: 600, … })`: the five stations of
  the build with their typical seconds (`BUILD_TYPICAL`).
- `startStation({ key, typical, restoreFrom })`: a station after the build, a
  VM started from the sealed image, with its small steps (`START_STEPS`:
  measure, instance, network, unlock, ready, from `facts.vmStep`) and flows.
- `stationOfBuildStep(step)`: `onProgress({ step })` → station.
- `withFacts(facts, step, data, now)`: what was reported so far; keeps only
  values that look like what they claim (hashes, relay, host, counts).
- `journey({ stations, station, since, now, facts, fetchPct, done })`: index,
  share done, seconds left (the fetch by its bytes and measured speed, the
  rest by typical time, an overrun keeps a minute in hand), when it ends.
- `substeps({ stations, station, current, facts, done })`: the small steps,
  each `done`, `active` or `next`.
- `flowNow({ stations, station, facts, fetchPct })`: the path through the
  places, what it carries, and its `kind`: `data` (pieces, drawn as dots),
  `key` (the passphrase that seals, the key that unlocks a VM) or `report`
  (an attestation report), drawn as a key or a shield travelling alone.
- `marksNow({ stations, station, facts, builder, done })`: what happened
  where, as icons on the places with a note under each: the hardware's
  measurement at the node and the browser's check of it (`ok` false when it
  is not one the app pins), the key that seals the image in the node, the
  fetch's connections each checked, the STORE signed in the browser and
  stored on Aleph, and a start station's VM measured, checked and unlocked.
  Only what a report says happened, or what happens now (`now`, blinking).
- `fetchPercent`, `fetchRate` (MiB/s).
- `evidence(facts, builder, links)`: the rows to check, with links: source
  commit, plain image SHA-256 (its STORE), expected measurement (where the
  app pins it), builder V-PROGRAM, node, relay, the measurement the AMD
  processor reported (`ok`: it is one the app pins), content address, the
  STORE, and after a start the INSTANCE and its measurement. `reported(rows)`
  keeps what the build reported (not the pins).
- `HARDWARE`, `PLACES`, `LINKS`, `pathOf`, `onPath`, `short`, `minutes`.

`builder` is the app's pin as `@le-space/sealed-image` takes it:
`{ plain: { sha256, store, commit }, measurements, crn }`. `links` are bases:
`{ aleph: 'https://api2.aleph.im/api/v0/messages', repo: 'https://github.com/…', expected: '<url of the pin>' }`.

## View (`@le-space/build-journey/BuildJourney.svelte`)

```svelte
<script>
	import BuildJourney from '@le-space/build-journey/BuildJourney.svelte';
	import { stationOfBuildStep, withFacts } from '@le-space/build-journey';

	let view = $state({ station: 'wake', since: Date.now(), done: false, failed: false, minimized: false, facts: {} });
	const onProgress = ({ step, data }) => {
		view.facts = withFacts(view.facts, step, data);
		const station = stationOfBuildStep(step);
		if (station && station !== view.station) Object.assign(view, { station, since: Date.now() });
	};
</script>

<BuildJourney {view} text={(key, vars) => t(`journey.${key}`, vars)} builder={BUILDER} links={LINKS}
	onminimize={() => (view.minimized = true)} onexpand={() => (view.minimized = false)} onclose={close} />
```

Stations with their LEDs, the small steps of the current one, the animated
picture of what flows where (with keys, checks and measurements where they
happen), the evidence with links and the hardware behind
it, the total bar with the time left and when it ends, a slim bar when
minimised, the finale, and when it stopped: where, and `reason`. While it
runs it holds a Wake Lock (`wakeLock={false}` when the app holds one), asks
before the page is left, notes how long the page was in the background, and
the tab's title carries the progress.

Props: `view` (`{ station, since, done, failed, minimized, facts, fetchPct? }`),
`text`, `stations`, `locale`, `builder`, `links`, `hardware` (null hides it),
`places` and `lines` (the picture), `reason`, `hint` (e.g. a phone's), 
`uploadHosts` (tries of the upload), `simple` (no small steps, no evidence), `finaleEvidence` (the build's evidence in the finale, default on),
`wakeLock`, `miniAt` (`'bottom'` fixed, `'top'` sticky), `openHref` and
`oncertificate` (the finale's buttons), `cover` (a snippet shown in the
overlay instead, e.g. a certificate), `testid` (prefix, default
`build-journey`), `onminimize`, `onexpand`, `onclose`.

### Texts

Every word comes from `text(key, vars)`, so each app keeps its own catalogue.
Keys (`{var}` the values handed in):

- `kicker`, `title`, `minimize`, `expand`, `close`, `tab` `{pct}`, `leave`
- `step` `{n, of}`, `stoppedAt` `{n, station}`, `failedTitle`, `failedText`
- `stations.<key>.label|duration|title|text|mini` for each station
- `sub.<key>`: `ask boot answer` · `relay report match` · `send verify luks` ·
  `lanes bytes` · `sign upload confirm` · a start: `measure instance network unlock ready`
- `attested` `{count}`, `mib` `{got, size}`, `rate` `{rate}`, `attempt` `{n, of}`,
  `retryNote`, `fetched` `{pct}`
- `flowTitle`, `flow.program|report|passphrase|pieces|image` (a start:
  `instance|vmReport|unlockKey|backup`), `places.<key>` (`browser relay node aleph`, and
  any the app adds)
- `marks.measuring|measured|attested|mismatch|sealing|sealed|lanes` `{count}`
  `|signing|signed|stored` (a start: `vmMeasuring|vmMeasured|vmAttested|unlocking|unlocked`):
  the notes on the picture; on a narrow screen they stand as a list under it
- `evidenceTitle`, `evidence.commit|plain|expected|vprogram|node|relay|measured|cid|store|instance|vmMeasured`,
  `matches`, `evidenceNone`, `evidenceNoneStopped`, `hardwareTitle`, `hardware.sev|epyc`
- `share` `{pct}`, `left` `{minutes}`, `endsAt` `{time}`, `keepOpen`, `cameBack` `{seconds}`
- `doneTitle`, `doneText`, and with the finale's buttons `open`, `showCertificate`

An empty text for `evidenceNone`, `evidenceNoneStopped` or `cameBack` leaves that note out.

Nothing a third party sends is rendered as HTML: facts are text, and only
values that match their pattern become links, under the bases the app hands in.

## Tests

`pnpm --filter @le-space/build-journey test`: the model in Node, and the view
bundled for a browser (esbuild, the Svelte compiler, no Node built-ins) and
checked in Chromium through Playwright, in each state. Chromium once:
`pnpm exec playwright install chromium`; without it the view's test is
skipped, except in CI. `BUILD_JOURNEY_SHOTS=<dir>` leaves screenshots at
desktop and phone width.
