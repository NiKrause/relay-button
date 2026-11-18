<script>
	// The build of a sealed image as an event of its own: a full-screen view
	// with its stations, the small steps of the current one with their LEDs,
	// the picture of what flows where, the evidence with links to check it,
	// the time left and when it ends. It can shrink to a slim bar. While it
	// runs the screen stays on (Wake Lock), leaving the page asks first, and
	// the tab's title carries the progress. At the end: the finale; when it
	// stopped: where, and the reason the app hands in. Everything shown is
	// what the build reported (model.mjs withFacts); nothing is interpreted.
	//
	// Each app keeps its own words: `text(key, vars)` answers every text (the
	// keys are listed in the README), so an app's catalogue stays the one
	// place for them.
	import { onDestroy } from 'svelte';
	import {
		BUILD_STATIONS,
		HARDWARE,
		LINKS,
		PLACES,
		evidence,
		fetchPercent,
		fetchRate,
		flowNow,
		journey,
		minutes,
		onPath,
		pathOf,
		reported,
		short,
		substeps
	} from './model.mjs';

	/**
	 * @type {{
	 *   view: { station: string, since: number, done: boolean, failed: boolean, minimized?: boolean, facts?: import('./model.mjs').Facts, fetchPct?: number | null },
	 *   text: (key: string, vars?: Record<string, string | number>) => string,
	 *   stations?: import('./model.mjs').Station[],
	 *   locale?: string,
	 *   builder?: import('./model.mjs').BuilderPin,
	 *   links?: import('./model.mjs').EvidenceLinks,
	 *   hardware?: readonly { key: string, href: string }[] | null,
	 *   places?: Record<string, readonly number[]>,
	 *   lines?: readonly (readonly string[])[],
	 *   reason?: string | null,
	 *   hint?: string | null,
	 *   uploadHosts?: number | null,
	 *   simple?: boolean,
	 *   wakeLock?: boolean,
	 *   miniAt?: 'top' | 'bottom',
	 *   openHref?: string | null,
	 *   testid?: string,
	 *   cover?: import('svelte').Snippet,
	 *   onminimize?: () => void,
	 *   onexpand?: () => void,
	 *   onclose?: () => void,
	 *   oncertificate?: (() => void) | null
	 * }}
	 */
	let {
		view,
		text,
		stations: all = BUILD_STATIONS,
		locale = undefined,
		builder = null,
		links = {},
		hardware = HARDWARE,
		places = PLACES,
		lines = LINKS,
		reason = null,
		hint = null,
		uploadHosts = null,
		simple = false,
		wakeLock = true,
		miniAt = 'bottom',
		openHref = null,
		testid = 'build-journey',
		cover = undefined,
		onminimize = () => {},
		onexpand = () => {},
		onclose = () => {},
		oncertificate = null
	} = $props();

	let now = $state(Date.now());
	const tick = setInterval(() => (now = Date.now()), 1000);
	onDestroy(() => clearInterval(tick));

	const facts = $derived(view.facts ?? {});
	const fetchPct = $derived(view.fetchPct ?? null);
	const j = $derived(
		journey({ stations: all, station: view.station, since: view.since, now, facts, fetchPct, done: view.done })
	);
	const pct = $derived(Math.round(j.share * 100));
	const running = $derived(!view.done && !view.failed);
	const current = $derived(all[Math.min(j.index, all.length - 1)]?.key ?? view.station);
	const shown = $derived(
		all.map((s, i) => ({
			key: s.key,
			n: i + 1,
			done: view.done || i < j.index,
			active: !view.done && i === j.index
		}))
	);
	const steps = $derived(substeps({ stations: all, station: current, facts, done: view.done }));
	const flow = $derived(flowNow({ stations: all, station: current, facts, fetchPct }));
	const fetched = $derived(current === 'fetch' ? (fetchPercent(facts) ?? fetchPct) : null);
	const rate = $derived(fetchRate(facts, now));
	const ends = $derived(new Date(j.ends).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }));
	const proofs = $derived(evidence(facts, builder, links));
	const hasReport = $derived(reported(proofs).length > 0);
	const mib = (/** @type {number} */ b) => Math.round(b / 1048576);
	const st = (/** @type {string} */ key, /** @type {string} */ part) => text(`stations.${key}.${part}`);

	/** What a small step adds: connections confirmed, bytes and speed, the upload's host and try. @param {string} key */
	const extra = (key) => {
		if (key === 'lanes' && facts.attested) return text('attested', { count: facts.attested });
		if (key === 'bytes' && facts.size) {
			const amount = text('mib', { got: mib(facts.got ?? 0), size: mib(facts.size) });
			return rate
				? `${amount} · ${text('rate', { rate: rate.toLocaleString(locale, { maximumFractionDigits: 1 }) })}`
				: amount;
		}
		if (key === 'upload' && facts.host && current === 'store') {
			const host = String(facts.host).replace(/^https?:\/\//, '').replace(/\/$/, '');
			const tries = facts.attempt ?? 1;
			return tries > 1
				? `${text('attempt', { n: tries, of: uploadHosts ?? tries })} · ${host}`
				: host;
		}
		return '';
	};
	const retrying = $derived(current === 'store' && (facts.attempt ?? 1) > 1 && !facts.processed);

	// The picture: where each place sits, and the path the data takes now.
	const pathD = $derived(pathOf(flow.path, places));
	const ids = $derived({ title: `${testid}-title` });

	// The screen stays on while it runs, and comes back on after the tab was hidden.
	/** @type {any} */
	let lock = null;
	async function wake() {
		try {
			lock = (await /** @type {any} */ (navigator).wakeLock?.request('screen')) ?? null;
		} catch {
			lock = null;
		}
	}
	$effect(() => {
		if (!running || !wakeLock) return;
		wake();
		const visible = () => document.visibilityState === 'visible' && wake();
		document.addEventListener('visibilitychange', visible);
		return () => {
			document.removeEventListener('visibilitychange', visible);
			lock?.release?.()?.catch?.(() => {});
			lock = null;
		};
	});
	// When the page was away, say for how long: a phone may stop a hidden tab.
	let hiddenAt = 0;
	let away = $state(0);
	$effect(() => {
		if (!running) return;
		const seen = () => {
			if (document.visibilityState === 'hidden') hiddenAt = Date.now();
			else if (hiddenAt) {
				const s = Math.round((Date.now() - hiddenAt) / 1000);
				hiddenAt = 0;
				if (s >= 5) away = s;
			}
		};
		document.addEventListener('visibilitychange', seen);
		return () => document.removeEventListener('visibilitychange', seen);
	});
	// Leaving the page would stop the build: the browser asks first.
	$effect(() => {
		if (!running) return;
		const leave = text('leave');
		const ask = (/** @type {BeforeUnloadEvent} */ e) => {
			e.preventDefault();
			e.returnValue = leave;
			return leave;
		};
		window.addEventListener('beforeunload', ask);
		return () => window.removeEventListener('beforeunload', ask);
	});
	// The tab's title carries the progress, and gets its own back afterwards.
	const before = typeof document === 'undefined' ? '' : document.title;
	$effect(() => {
		document.title = running ? text('tab', { pct }) : before;
	});
	onDestroy(() => {
		if (typeof document !== 'undefined') document.title = before;
	});
</script>

{#snippet check(/** @type {number} */ size)}
	<svg
		width={size}
		height={size}
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2.5"
		stroke-linecap="round"
		stroke-linejoin="round"
		aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"></path></svg
	>
{/snippet}

{#snippet value(/** @type {import('./model.mjs').Evidence} */ p)}
	{#if p.href}<a href={p.href} target="_blank" rel="noopener noreferrer"><code>{short(p.value)}</code></a
		>{:else}<code>{short(p.value)}</code>{/if}
{/snippet}

{#if view.minimized && running}
	<div class="bj-mini" class:top={miniAt === 'top'} role="status" data-testid="{testid}-mini">
		<span class="dot pulse" aria-hidden="true"></span>
		<strong>{st(current, 'mini')}</strong>
		<span class="bar"><span class="fill shimmer" style="width: {pct}%"></span></span>
		<span>{pct} % · {text('left', { minutes: minutes(j.left) })}</span>
		<button type="button" onclick={onexpand} data-testid="{testid}-expand">{text('expand')}</button>
	</div>
{:else}
	<div
		class="bj-overlay"
		role="dialog"
		aria-modal="true"
		aria-labelledby={ids.title}
		data-testid={testid}
		data-station={current}
		data-state={view.done ? 'done' : view.failed ? 'stopped' : 'running'}
	>
		{#if cover}
			{@render cover()}
		{:else if view.done}
			<div class="finale" data-testid="{testid}-done">
				<div class="big pop" aria-hidden="true">
					<span class="spark s1"></span><span class="spark s2"></span><span class="spark s3"></span><span
						class="spark s4"
					></span>
					<span class="spin ring"></span>
					{@render check(52)}
				</div>
				<h2 id={ids.title}>{text('doneTitle')}</h2>
				<p>{text('doneText')}</p>
				{#if !simple && hasReport}
					<ul class="proofs-inline" data-testid="{testid}-done-evidence">
						{#each reported(proofs) as p (p.key)}
							<li>
								<span class="led on" aria-hidden="true"></span>
								<span>{text(`evidence.${p.key}`)}{#if p.ok}{' · '}<em>{text('matches')}</em>{/if}</span>
								{@render value(p)}
							</li>
						{/each}
					</ul>
				{/if}
				<p class="row center">
					{#if openHref}<a
							class="cta"
							href={openHref}
							target="_blank"
							rel="noopener noreferrer"
							data-testid="{testid}-open">{text('open')}</a
						>{/if}
					{#if oncertificate}<button
							type="button"
							class="secondary"
							onclick={oncertificate}
							data-testid="{testid}-certificate">{text('showCertificate')}</button
						>{/if}
					<button
						type="button"
						class={openHref ? 'link' : 'cta'}
						onclick={onclose}
						data-testid="{testid}-close">{text('close')}</button
					>
				</p>
			</div>
		{:else}
			<div class="journey">
				<div class="top">
					<div>
						<p class="kicker">{text('kicker')}</p>
						<h2 id={ids.title}>{text('title')}</h2>
					</div>
					{#if running}
						<button type="button" class="ghost" onclick={onminimize} data-testid="{testid}-minimize"
							>{text('minimize')}</button
						>
					{:else}
						<button type="button" class="ghost" onclick={onclose} data-testid="{testid}-close"
							>{text('close')}</button
						>
					{/if}
				</div>
				<ol class="stations" style="--n: {all.length}">
					{#each shown as s (s.key)}
						<li
							class:done={s.done}
							class:active={s.active}
							aria-current={s.active ? 'step' : undefined}
							data-testid="{testid}-station-{s.key}"
							data-state={s.done ? 'done' : s.active ? (running ? 'active' : 'stopped') : 'next'}
						>
							<span class="circle" class:pulse={s.active && running} class:stop={s.active && !running}>
								{#if s.done}{@render check(26)}{:else}{s.n}{/if}
								{#if s.active && running}<span class="ring spin" aria-hidden="true"></span>{/if}
							</span>
							<span class="label">{st(s.key, 'label')}</span>
							<span class="dur">{st(s.key, 'duration')}</span>
						</li>
					{/each}
				</ol>
				<div class="leds" aria-hidden="true">
					{#each shown as s (s.key)}<span
							class="led"
							class:on={s.done}
							class:blink={s.active && running}
							class:off={s.active && !running}
						></span>{/each}
				</div>
				<div class="grid" class:single={simple}>
					<div class="col">
						<div class="now" aria-live="polite">
							{#if view.failed}
								<p class="step">{text('stoppedAt', { n: j.index + 1, station: st(current, 'label') })}</p>
								<h3>{text('failedTitle')}</h3>
								{#if reason}
									<p class="reason" role="alert" data-testid="{testid}-reason">{reason}</p>
								{/if}
								<p>{text('failedText')}</p>
							{:else}
								<p class="step">{text('step', { n: j.index + 1, of: all.length })} · {st(current, 'duration')}</p>
								<h3 data-testid="{testid}-stage">{st(current, 'title')}</h3>
								<p>{st(current, 'text')}</p>
								{#if !simple}
									<ul class="subs" data-testid="{testid}-substeps">
										{#each steps as s (s.key)}
											<li class={s.state} data-state={s.state}>
												<span
													class="led"
													class:on={s.state === 'done'}
													class:blink={s.state === 'active'}
													aria-hidden="true"
												></span>
												<span
													>{text(`sub.${s.key}`)}{#if extra(s.key)}<small class="extra">{extra(s.key)}</small
														>{/if}</span
												>
											</li>
										{/each}
									</ul>
								{/if}
								{#if retrying}<p class="small" data-testid="{testid}-retry">{text('retryNote')}</p>{/if}
								{#if fetched != null}
									<span class="bar big-bar"><span class="fill gold shimmer" style="width: {fetched}%"></span></span>
									<p class="small" data-testid="{testid}-fetched">{text('fetched', { pct: fetched })}</p>
								{/if}
							{/if}
						</div>
						{#if running}
							<figure class="flow" data-testid="{testid}-flow" data-what={flow.what}>
								<figcaption>
									{text('flowTitle')}: <strong>{text(`flow.${flow.what}`)}</strong>{#if flow.share != null}<span
											class="extra">{Math.round(flow.share * 100)} %</span
										>{/if}
								</figcaption>
								<svg viewBox="0 0 720 250" role="img" aria-label="{text('flowTitle')}: {text(`flow.${flow.what}`)}">
									{#each lines as [a, b] (a + b)}
										{#if places[a] && places[b]}
											<line
												x1={places[a][0]}
												y1={places[a][1]}
												x2={places[b][0]}
												y2={places[b][1]}
												class:hot={onPath(flow.path, a, b)}
											/>
										{/if}
									{/each}
									{#key pathD}
										{#each [0, 0.6, 1.2] as delay (delay)}
											<circle r="6" class="packet" opacity="0"
												><set attributeName="opacity" to="1" begin="{delay}s" /><animateMotion
													dur="1.8s"
													begin="{delay}s"
													repeatCount="indefinite"
													path={pathD}
												/></circle
											>
										{/each}
									{/key}
									{#each Object.entries(places) as [p, [cx, cy]] (p)}
										<g class="place" class:hot={flow.path.includes(p)}>
											<rect x={cx - 86} y={cy - 18} width="172" height="36" rx="10" />
											<circle cx={cx - 70} {cy} r="5" class="lamp" class:blink={flow.path.includes(p)} />
											<text x={cx - 58} y={cy + 5}>{text(`places.${p}`)}</text>
										</g>
									{/each}
								</svg>
								{#if flow.share != null}<span class="bar"
										><span class="fill" style="width: {Math.round(flow.share * 100)}%"></span></span
									>{/if}
							</figure>
						{/if}
					</div>
					{#if !simple}
						<aside class="proofs" data-testid="{testid}-evidence">
							<h4>{text('evidenceTitle')}</h4>
							{#if proofs.length}
								<ul>
									{#each proofs as p (p.key)}
										<li class="pop" data-key={p.key}>
											<span class="led on" aria-hidden="true"></span>
											<span class="what"
												>{text(`evidence.${p.key}`)}{#if p.ok}{' · '}<em>{text('matches')}</em>{/if}</span
											>
											{@render value(p)}
										</li>
									{/each}
								</ul>
							{/if}
							{#if !hasReport}
								<p class="small">{running ? text('evidenceNone') : text('evidenceNoneStopped')}</p>
							{/if}
							{#if hardware?.length}
								<h4>{text('hardwareTitle')}</h4>
								<ul>
									{#each hardware as h (h.key)}<li>
											<span class="led on" aria-hidden="true"></span><a
												href={h.href}
												target="_blank"
												rel="noopener noreferrer">{text(`hardware.${h.key}`)}</a
											>
										</li>{/each}
								</ul>
							{/if}
						</aside>
					{/if}
				</div>
				{#if running}
					<div class="total">
						<p class="row between">
							<strong data-testid="{testid}-share">{text('share', { pct })}</strong>
							<span>{text('left', { minutes: minutes(j.left) })} · {text('endsAt', { time: ends })}</span>
						</p>
						<span class="bar"><span class="fill shimmer" style="width: {pct}%"></span></span>
						{#if away}
							<p class="warn" role="status" data-testid="{testid}-away">{text('cameBack', { seconds: away })}</p>
						{/if}
						{#if hint}<p class="small" data-testid="{testid}-hint">{hint}</p>{/if}
						<p class="small">{text('keepOpen')}</p>
					</div>
				{/if}
			</div>
		{/if}
	</div>
{/if}

<style>
	.bj-overlay {
		position: fixed;
		inset: 0;
		z-index: 50;
		overflow-y: auto;
		background: #0f2a2e;
		color: #f6f2ea;
		display: flex;
		justify-content: center;
		align-items: flex-start;
		padding: clamp(1rem, 4vw, 3rem) 1rem;
		box-sizing: border-box;
		text-align: left;
	}
	.journey,
	.finale {
		width: 100%;
		max-width: 68rem;
		display: flex;
		flex-direction: column;
		gap: 2rem;
	}
	.top {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		align-items: flex-start;
		gap: 1rem;
	}
	.kicker {
		margin: 0;
		font-size: 0.8rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: #5eead4;
	}
	h2,
	h3 {
		color: #f6f2ea;
	}
	h2 {
		margin: 0.4rem 0 0;
		font-size: clamp(1.8rem, 4vw, 2.6rem);
		line-height: 1.1;
		font-weight: 700;
	}
	h3 {
		margin: 0;
		font-size: clamp(1.4rem, 3vw, 1.9rem);
		font-weight: 600;
	}
	button {
		font: inherit;
		min-height: 2.75rem;
	}
	.ghost {
		padding: 0.6rem 1.1rem;
		border-radius: 999px;
		border: 1px solid rgba(246, 242, 234, 0.35);
		background: transparent;
		color: inherit;
		cursor: pointer;
	}
	.stations {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(var(--n, 5), minmax(0, 1fr));
		gap: 0.75rem;
	}
	@media (max-width: 720px) {
		.stations {
			grid-template-columns: repeat(3, minmax(0, 1fr));
			row-gap: 1.25rem;
		}
	}
	.stations li {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.5rem;
		text-align: center;
	}
	.circle {
		position: relative;
		width: 4rem;
		height: 4rem;
		border-radius: 50%;
		border: 2px solid rgba(246, 242, 234, 0.25);
		display: flex;
		align-items: center;
		justify-content: center;
		font-weight: 700;
		font-size: 1.2rem;
		color: rgba(246, 242, 234, 0.65);
		box-sizing: border-box;
	}
	.active .circle {
		background: #f6f2ea;
		color: #0f2a2e;
		border-color: #f6f2ea;
	}
	.active .circle.stop {
		background: transparent;
		color: #fecaca;
		border-color: #f87171;
	}
	.done .circle {
		background: #0f766e;
		border-color: #0f766e;
		color: #f6f2ea;
		animation: pop 0.7s cubic-bezier(0.2, 0.9, 0.3, 1.2) both;
	}
	.ring {
		position: absolute;
		inset: -7px;
		border-radius: 50%;
		border: 2px dashed #5eead4;
	}
	.label {
		font-weight: 600;
	}
	.dur {
		font-size: 0.8rem;
		color: rgba(246, 242, 234, 0.7);
	}
	.leds {
		display: flex;
		gap: 0.5rem;
		justify-content: center;
	}
	.now {
		background: rgba(246, 242, 234, 0.06);
		border: 1px solid rgba(246, 242, 234, 0.14);
		border-radius: 20px;
		padding: 1.5rem;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.now p {
		margin: 0;
		line-height: 1.55;
		max-width: 48rem;
		color: rgba(246, 242, 234, 0.9);
	}
	.now .step {
		font-size: 0.8rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: #f5c76b;
	}
	.total {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}
	.led {
		display: inline-block;
		flex: none;
		width: 0.6rem;
		height: 0.6rem;
		border-radius: 50%;
		background: rgba(246, 242, 234, 0.2);
		box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.25);
	}
	.led.on {
		background: #34d399;
		box-shadow: 0 0 8px #34d399;
	}
	.led.blink {
		background: #f5c76b;
		box-shadow: 0 0 10px #f5c76b;
		animation: blink 0.9s steps(2, start) infinite;
	}
	.led.off {
		background: #f87171;
		box-shadow: 0 0 8px #f87171;
	}
	.grid {
		display: grid;
		grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr);
		gap: 1.25rem;
		align-items: start;
	}
	.grid.single {
		grid-template-columns: 1fr;
	}
	@media (max-width: 860px) {
		.grid {
			grid-template-columns: 1fr;
		}
	}
	.col {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
		min-width: 0;
	}
	.subs {
		list-style: none;
		margin: 0.25rem 0 0;
		padding: 0;
		display: grid;
		gap: 0.45rem;
	}
	.subs li {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		column-gap: 0.6rem;
		align-items: baseline;
		color: rgba(246, 242, 234, 0.9);
	}
	.subs li.next {
		color: rgba(246, 242, 234, 0.5);
	}
	.subs small {
		color: #f5c76b;
	}
	.extra::before {
		content: ' · ';
		color: rgba(246, 242, 234, 0.5);
	}
	.flow {
		margin: 0;
		background: rgba(246, 242, 234, 0.04);
		border: 1px solid rgba(246, 242, 234, 0.12);
		border-radius: 20px;
		padding: 1rem 1.25rem;
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}
	.flow figcaption {
		font-size: 0.9rem;
		color: rgba(246, 242, 234, 0.85);
	}
	.flow svg {
		width: 100%;
		height: auto;
	}
	.flow line {
		stroke: rgba(246, 242, 234, 0.15);
		stroke-width: 2;
		stroke-dasharray: 4 6;
	}
	.flow line.hot {
		stroke: rgba(94, 234, 212, 0.55);
		stroke-dasharray: none;
	}
	.flow .packet {
		fill: #f5c76b;
		filter: drop-shadow(0 0 4px #f5c76b);
	}
	.place rect {
		fill: #133a3f;
		stroke: rgba(246, 242, 234, 0.2);
	}
	.place.hot rect {
		stroke: #5eead4;
	}
	.place text {
		fill: #f6f2ea;
		font-size: 13px;
		font-weight: 600;
	}
	.lamp {
		fill: rgba(246, 242, 234, 0.25);
	}
	.lamp.blink {
		fill: #34d399;
		animation: blink 0.9s steps(2, start) infinite;
	}
	.proofs {
		background: rgba(246, 242, 234, 0.04);
		border: 1px solid rgba(246, 242, 234, 0.12);
		border-radius: 20px;
		padding: 1.1rem 1.25rem;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}
	.proofs h4 {
		margin: 0;
		font-size: 0.8rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: #5eead4;
	}
	.proofs ul + h4,
	.proofs p + h4 {
		margin-top: 0.6rem;
	}
	.proofs ul,
	.proofs-inline {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.55rem;
	}
	.proofs li,
	.proofs-inline li {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		column-gap: 0.55rem;
		align-items: baseline;
		font-size: 0.85rem;
	}
	.proofs li > a,
	.proofs li > code,
	.proofs-inline li > a,
	.proofs-inline li > code {
		grid-column: 2;
	}
	.proofs .what {
		color: rgba(246, 242, 234, 0.8);
	}
	em {
		color: #34d399;
		font-style: normal;
		font-weight: 600;
	}
	a {
		color: #5eead4;
	}
	code {
		font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
		font-size: 0.8rem;
		overflow-wrap: anywhere;
		color: #5eead4;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.75rem;
		margin: 0;
	}
	.between {
		justify-content: space-between;
	}
	.center {
		justify-content: center;
	}
	.reason {
		padding: 0.75rem 1rem;
		border-radius: 12px;
		background: rgba(248, 113, 113, 0.14);
		border: 1px solid rgba(248, 113, 113, 0.4);
		color: #fecaca !important;
		overflow-wrap: anywhere;
	}
	.warn {
		margin: 0;
		padding: 0.6rem 0.9rem;
		border-radius: 12px;
		background: rgba(245, 199, 107, 0.15);
		color: #f5c76b;
		font-size: 0.9rem;
	}
	.small {
		margin: 0;
		font-size: 0.85rem;
		color: rgba(246, 242, 234, 0.72);
	}
	.bar {
		display: block;
		height: 10px;
		border-radius: 999px;
		background: rgba(246, 242, 234, 0.15);
		overflow: hidden;
	}
	.big-bar {
		height: 14px;
		max-width: 48rem;
	}
	.fill {
		display: block;
		height: 100%;
		border-radius: 999px;
		background-color: #5eead4;
		transition: width 1s ease;
	}
	.fill.gold {
		background-color: #f5c76b;
	}
	.finale {
		align-items: center;
		text-align: center;
		max-width: 44rem;
		padding-top: 3rem;
	}
	.finale p {
		margin: 0;
		line-height: 1.55;
		color: rgba(246, 242, 234, 0.9);
	}
	.proofs-inline {
		text-align: left;
		width: 100%;
	}
	.big {
		position: relative;
		width: 7rem;
		height: 7rem;
		border-radius: 50%;
		background: #0f766e;
		display: flex;
		align-items: center;
		justify-content: center;
		color: #fff;
	}
	.big .ring {
		inset: -10px;
		border: 3px dashed #f5c76b;
	}
	.cta {
		display: inline-flex;
		align-items: center;
		padding: 0.8rem 1.5rem;
		min-height: 2.75rem;
		box-sizing: border-box;
		border-radius: 999px;
		background: #f6f2ea;
		color: #0f2a2e;
		font-weight: 600;
		border: none;
		cursor: pointer;
		text-decoration: none;
	}
	.secondary {
		padding: 0.8rem 1.5rem;
		border-radius: 999px;
		border: 1px solid #f6f2ea;
		background: transparent;
		color: #f6f2ea;
		font-weight: 600;
		cursor: pointer;
	}
	.link {
		background: none;
		border: none;
		color: rgba(246, 242, 234, 0.8);
		text-decoration: underline;
		cursor: pointer;
	}
	.bj-mini {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		z-index: 40;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.75rem 1rem;
		padding: 0.7rem 1.25rem;
		background: #0f3d3a;
		color: #f6f2ea;
	}
	.bj-mini.top {
		position: sticky;
		top: 0;
		bottom: auto;
	}
	.bj-mini .bar {
		flex: 1 1 10rem;
		height: 6px;
		min-width: 6rem;
	}
	.bj-mini button {
		padding: 0.4rem 0.9rem;
		border-radius: 999px;
		border: 1px solid #5eead4;
		background: transparent;
		color: inherit;
		cursor: pointer;
	}
	.dot {
		width: 0.75rem;
		height: 0.75rem;
		border-radius: 50%;
		background: #5eead4;
	}
	.spark {
		position: absolute;
		width: 8px;
		height: 8px;
		border-radius: 2px;
		bottom: 0;
		animation: rise 2.4s ease-out infinite;
	}
	.s1 {
		left: -2.5rem;
		background: #5eead4;
	}
	.s2 {
		left: 1rem;
		background: #f5c76b;
		animation-delay: 0.5s;
	}
	.s3 {
		right: 1rem;
		background: #5eead4;
		animation-delay: 1s;
	}
	.s4 {
		right: -2.5rem;
		background: #f5c76b;
		animation-delay: 1.5s;
	}
	.pulse {
		animation: pulse 1.8s ease-out infinite;
	}
	.spin {
		animation: spin 6s linear infinite;
	}
	.pop {
		animation: pop 0.7s cubic-bezier(0.2, 0.9, 0.3, 1.2) both;
	}
	.shimmer {
		background-image: linear-gradient(
			90deg,
			rgba(255, 255, 255, 0) 0,
			rgba(255, 255, 255, 0.45) 50%,
			rgba(255, 255, 255, 0) 100%
		);
		background-size: 200px 100%;
		background-repeat: no-repeat;
		animation: shimmer 1.6s linear infinite;
	}
	@keyframes blink {
		to {
			opacity: 0.25;
		}
	}
	@keyframes pulse {
		0% {
			box-shadow: 0 0 0 0 rgba(94, 234, 212, 0.5);
		}
		70% {
			box-shadow: 0 0 0 18px rgba(94, 234, 212, 0);
		}
		100% {
			box-shadow: 0 0 0 0 rgba(94, 234, 212, 0);
		}
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	@keyframes pop {
		0% {
			transform: scale(0.6);
			opacity: 0;
		}
		60% {
			transform: scale(1.08);
			opacity: 1;
		}
		100% {
			transform: scale(1);
		}
	}
	@keyframes shimmer {
		0% {
			background-position: -200px 0;
		}
		100% {
			background-position: 200px 0;
		}
	}
	@keyframes rise {
		0% {
			transform: translateY(0);
			opacity: 1;
		}
		100% {
			transform: translateY(-140px);
			opacity: 0;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.pulse,
		.spin,
		.pop,
		.shimmer,
		.done .circle,
		.led.blink,
		.lamp.blink {
			animation: none;
		}
		.packet,
		.spark {
			display: none;
		}
		.fill {
			transition: none;
		}
	}
	@media print {
		.bj-overlay {
			position: static;
			background: none;
			color: inherit;
			padding: 0;
		}
	}
</style>
