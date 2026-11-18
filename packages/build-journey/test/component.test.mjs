// The view in Chromium: test/fixture/page.mjs bundled for a browser (esbuild,
// the Svelte compiler, the `browser` condition, no Node built-ins), opened
// through Playwright, each state checked. With BUILD_JOURNEY_SHOTS=<dir>
// it also leaves screenshots at desktop and phone width there.
//
// Chromium for Playwright: `pnpm exec playwright install chromium` once. In
// CI (`CI` set) a missing browser fails the test; elsewhere it is skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BUILTINS = new Set(builtinModules);

async function bundle() {
	const esbuild = await import('esbuild');
	const { compile } = await import('svelte/compiler');
	const out = await esbuild.build({
		entryPoints: [join(here, 'fixture', 'page.mjs')],
		bundle: true,
		write: false,
		format: 'esm',
		platform: 'browser',
		target: 'es2022',
		conditions: ['svelte', 'browser'],
		plugins: [
			{
				name: 'svelte-and-no-node',
				setup(build) {
					build.onResolve({ filter: /.*/ }, (a) => {
						if (a.path.startsWith('node:') || BUILTINS.has(a.path.split('/')[0]))
							throw new Error(`a Node-only import in a browser build: '${a.path}' from ${a.importer}`);
						return undefined;
					});
					build.onLoad({ filter: /\.svelte$/ }, async (a) => {
						const source = await readFile(a.path, 'utf8');
						const { js, warnings } = compile(source, { filename: a.path, generate: 'client', css: 'injected', dev: false });
						return { contents: js.code, loader: 'js', warnings: warnings.map((w) => ({ text: w.message })) };
					});
				}
			}
		]
	});
	return out.outputFiles[0].text;
}

/** @param {string} js */
function serve(js) {
	const server = createServer((req, res) => {
		if (req.url === '/page.js') return void res.writeHead(200, { 'content-type': 'text/javascript' }).end(js);
		res
			.writeHead(200, { 'content-type': 'text/html' })
			.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>scenario</title><body style="margin:0;font-family:sans-serif"><script type="module" src="/page.js"></script></body>');
	});
	return /** @type {Promise<{ url: string, close: () => void }>} */ (
		new Promise((resolve) =>
			server.listen(0, '127.0.0.1', () =>
				resolve({ url: `http://127.0.0.1:${/** @type {any} */ (server.address()).port}/`, close: () => server.close() })
			)
		)
	);
}

test('the view in Chromium: running, stopped, done, minimised, with a start station', async (t) => {
	const { chromium } = await import('@playwright/test');
	const browser = await chromium.launch().catch((/** @type {Error} */ e) => {
		if (process.env.CI) throw e;
		return null;
	});
	if (!browser) return t.skip('no Chromium for Playwright (pnpm exec playwright install chromium)');
	const site = await serve(await bundle());
	const shots = process.env.BUILD_JOURNEY_SHOTS;
	if (shots) await mkdir(shots, { recursive: true });
	try {
		const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
		/** @type {string[]} */
		const errors = [];
		page.on('pageerror', (e) => errors.push(String(e)));
		await page.goto(site.url);
		await page.waitForFunction(() => /** @type {any} */ (window).ready);
		const show = (/** @type {string} */ name) => page.evaluate((n) => /** @type {any} */ (window).show(n), name);
		const id = (/** @type {string} */ s) => page.getByTestId(s);
		const shoot = async (/** @type {string} */ name) => {
			if (!shots) return;
			for (const [w, h, tag] of [[1280, 900, 'desktop'], [390, 844, 'phone']]) {
				await page.setViewportSize({ width: /** @type {number} */ (w), height: /** @type {number} */ (h) });
				await page.waitForTimeout(800);
				await page.screenshot({ path: join(shots, `${name}-${tag}.png`), fullPage: true });
			}
			await page.setViewportSize({ width: 1280, height: 900 });
		};

		// Running, at the fetch: stations, small steps, bytes and speed, flow, evidence with links.
		await show('fetch');
		const view = id('build-journey');
		assert.equal(await view.getAttribute('data-state'), 'running');
		assert.equal(await view.getAttribute('data-station'), 'fetch');
		assert.equal(await id('build-journey-station-seal').getAttribute('data-state'), 'done');
		assert.equal(await id('build-journey-station-fetch').getAttribute('data-state'), 'active');
		assert.equal(await id('build-journey-station-store').getAttribute('data-state'), 'next');
		assert.equal(await id('build-journey-stage').textContent(), 'Your image is on its way');
		const subs = await id('build-journey-substeps').innerText();
		assert.match(subs, /21 confirmed/);
		assert.match(subs, /450 of 900 MiB · 1 MiB\/s/);
		assert.equal(await id('build-journey-fetched').textContent(), '50 % fetched');
		assert.equal(await id('build-journey-flow').getAttribute('data-what'), 'pieces');
		const ev = id('build-journey-evidence');
		const keys = await ev.locator('li[data-key]').evaluateAll((li) => li.map((l) => l.getAttribute('data-key')));
		assert.deepEqual(keys, ['commit', 'plain', 'expected', 'vprogram', 'node', 'relay', 'measured', 'cid']);
		assert.equal(await ev.locator('li[data-key=commit] a').getAttribute('href'), 'https://example.com/app/commit/0123abcd');
		assert.equal(await ev.locator('li[data-key=plain] a').getAttribute('href'), `https://aleph.example.com/messages/${'2'.repeat(64)}`);
		assert.match(await ev.locator('li[data-key=measured]').innerText(), /matches/);
		assert.equal(await ev.getByRole('link', { name: 'AMD SEV-SNP' }).getAttribute('href'), 'https://www.amd.com/en/developer/sev.html');
		assert.match(await page.title(), /^\d+ % · Image$/);
		assert.match(await id('build-journey-share').textContent() ?? '', /^\d+ % done$/);
		await shoot('fetch');
		await id('build-journey-minimize').click();

		// Leaving the page asks first while it runs.
		const asked = await page.evaluate(() => {
			const e = new Event('beforeunload', { cancelable: true });
			window.dispatchEvent(e);
			return e.defaultPrevented;
		});
		assert.equal(asked, true);

		// The store with a second try: host and try shown, the note too.
		await show('store');
		assert.match(await id('build-journey-substeps').innerText(), /try 2 of 3 · api\.example\.com/);
		await id('build-journey-retry').waitFor();

		// At the start: nothing reported yet, the hint shown.
		await show('wake');
		assert.equal(await id('build-journey-hint').textContent(), 'On a phone: stay here.');
		assert.match(await id('build-journey-evidence').innerText(), /Nothing measured yet\./);
		await shoot('wake');

		// Stopped: where, and why; no leaving prompt any more.
		await show('stopped');
		assert.equal(await view.getAttribute('data-state'), 'stopped');
		assert.equal(await id('build-journey-reason').textContent(), 'The builder did not answer.');
		assert.equal(await id('build-journey-station-check').getAttribute('data-state'), 'stopped');
		assert.match((await view.textContent()) ?? '', /Stopped at step 2 · Genuine/);
		assert.match(await id('build-journey-evidence').innerText(), /Nothing to show\./);
		assert.equal(await page.title(), 'scenario', 'the tab title is its own again');
		assert.equal(await id('build-journey-flow').count(), 0);
		await shoot('stopped');
		await id('build-journey-close').click();

		// Done: the finale with what the build reported, open, certificate, close.
		await show('done');
		await id('build-journey-done').waitFor();
		assert.match(await id('build-journey-done-evidence').innerText(), /On Aleph \(STORE\) · matches/);
		assert.equal(await id('build-journey-open').getAttribute('href'), 'https://example.com/open');
		await id('build-journey-certificate').click();
		await shoot('done');

		// Minimised: a slim bar, and back.
		await show('mini');
		await id('build-journey-mini').waitFor();
		assert.equal(await view.count(), 0);
		await id('build-journey-expand').click();

		// With a start station after the build: six stations, its own small steps and flow.
		await show('start');
		assert.equal(await page.locator('[data-testid^="build-journey-station-"]').count(), 6);
		assert.equal(await id('build-journey-station-start').getAttribute('data-state'), 'active');
		assert.equal(await id('build-journey-flow').getAttribute('data-what'), 'vmReport');
		const keysStart = await id('build-journey-evidence').locator('li[data-key]').evaluateAll((li) => li.map((l) => l.getAttribute('data-key')));
		assert.ok(keysStart.includes('store'));
		await shoot('start');

		// A cover (an app's certificate) takes the overlay.
		await show('cover');
		await id('cover').waitFor();
		assert.equal(await id('build-journey-done').count(), 0);

		const calls = await page.evaluate(() => /** @type {any} */ (window).calls);
		assert.deepEqual(calls, ['minimize', 'close', 'certificate', 'expand']);
		assert.deepEqual(await page.evaluate(() => /** @type {any} */ (window).missing), [], 'every text key is in the fixture');
		assert.deepEqual(errors, [], 'the page threw');
	} finally {
		await browser.close();
		site.close();
	}
});

test('the model bundles for a browser without Node built-ins', async () => {
	const esbuild = await import('esbuild');
	const dir = await mkdtemp(join(tmpdir(), 'build-journey-'));
	try {
		const entry = join(dir, 'entry.mjs');
		await writeFile(entry, `export * from ${JSON.stringify(join(here, '..', 'src', 'index.mjs'))};`);
		const out = await esbuild.build({ entryPoints: [entry], bundle: true, write: false, platform: 'browser', format: 'esm' });
		assert.doesNotMatch(out.outputFiles[0].text, /\bBuffer\b|\bprocess\.|['"]node:/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
