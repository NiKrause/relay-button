#!/usr/bin/env node
// Warns before an Aleph account that pays for relays runs out of credits.
//
// Read-only: it asks the public Aleph API for an account's credit balance,
// what its running instances cost and what its storage cost lately, and turns
// that into days of runway. No Aleph key is involved; nothing is bought or
// transferred. With GITHUB_TOKEN and GITHUB_REPOSITORY set (the daily workflow
// sets both) it keeps one GitHub issue per low account: opened or updated
// while the runway is short, closed once it is long enough again.
//
// Why: when an account reaches 0 credits Aleph tears its instances down, and a
// rebuilt relay comes back without its configuration.
//
// Environment:
//   ALEPH_CREDIT_ACCOUNTS  "<name> <0x address>" entries, one per line or
//                          comma-separated; "#" comments are ignored
//   RUNWAY_WARN_DAYS       alert below this many days (default 7)
//   RUNWAY_TARGET_DAYS     the top-up suggestion covers this many days (default 30)
//   ALEPH_API_HOSTS        comma-separated, tried in order (default api2, then api)
//   GITHUB_TOKEN, GITHUB_REPOSITORY  manage issues; without them it only reports
//   GITHUB_STEP_SUMMARY    a Markdown summary is appended here when set
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const ISSUE_LABEL = 'aleph-credits';
const SECONDS_PER_DAY = 86_400;
const HOURS_PER_DAY = 24;

/** Parses the account list: "<name> <address>" entries, one per line or comma-separated. */
export function parseAccounts(text) {
	const accounts = [];
	const entries = String(text ?? '')
		.split('\n')
		.flatMap((line) => line.replace(/#.*/, '').split(','));
	for (const raw of entries) {
		const line = raw.trim();
		if (!line) continue;
		const [name, address, ...rest] = line.split(/\s+/);
		if (!address || rest.length || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
			throw new Error(`Cannot read account line ${JSON.stringify(raw.trim())}; expected "<name> <0x address>".`);
		}
		accounts.push({ name, address });
	}
	if (!accounts.length) throw new Error('No accounts to check: ALEPH_CREDIT_ACCOUNTS is empty.');
	return accounts;
}

/**
 * Storage is charged hourly as one "storage" credit_expense entry per account.
 * The rate moves when STOREs are added or forgotten, so this averages only the
 * newest few entries: current enough to follow a cleanup within hours.
 */
export function storageCreditsPerHour(creditHistory, samples = 3) {
	const amounts = (creditHistory ?? [])
		.filter((entry) => entry.payment_method === 'credit_expense' && entry.origin_ref === 'storage')
		.sort((a, b) => String(b.message_timestamp).localeCompare(String(a.message_timestamp)))
		.slice(0, samples)
		.map((entry) => Math.abs(Number(entry.amount) || 0));
	if (!amounts.length) return 0;
	return amounts.reduce((sum, amount) => sum + amount, 0) / amounts.length;
}

/** Credits per second one instance costs, from GET /api/v0/price/<item_hash>. */
export function instanceCreditsPerSecond(price) {
	if (price?.payment_type !== 'credit') return 0;
	if (Array.isArray(price.detail) && price.detail.length) {
		return price.detail.reduce((sum, part) => sum + (Number(part.cost_credit) || 0), 0);
	}
	return Number(price.cost) || 0;
}

/**
 * The runway itself. Pure, so it can be tested with made-up numbers.
 *
 * @param {object} input
 * @param {number} input.creditBalance            credits left
 * @param {number[]} input.instanceCreditsPerSecond one entry per running instance
 * @param {number} input.storageCreditsPerHour
 * @param {number} [input.warnDays=7]
 * @param {number} [input.targetDays=30]
 */
export function computeRunway({
	creditBalance,
	instanceCreditsPerSecond: perSecond = [],
	storageCreditsPerHour: storagePerHour = 0,
	warnDays = 7,
	targetDays = 30,
}) {
	const balance = Math.max(0, Number(creditBalance) || 0);
	const instancesPerDay = perSecond.reduce((sum, rate) => sum + rate, 0) * SECONDS_PER_DAY;
	const storagePerDay = storagePerHour * HOURS_PER_DAY;
	const burnPerDay = instancesPerDay + storagePerDay;
	const runwayDays = burnPerDay > 0 ? balance / burnPerDay : Number.POSITIVE_INFINITY;
	const creditsForTarget = burnPerDay * targetDays;
	return {
		creditBalance: balance,
		instancesPerDay,
		storagePerDay,
		burnPerDay,
		runwayDays,
		low: runwayDays < warnDays,
		warnDays,
		targetDays,
		creditsForTarget,
		topUpForTarget: Math.max(0, creditsForTarget - balance),
		runsOutAt: Number.isFinite(runwayDays) ? new Date(Date.now() + runwayDays * SECONDS_PER_DAY * 1000) : null,
	};
}

const credits = (value) => Math.round(value).toLocaleString('en-US');
const days = (value) => (Number.isFinite(value) ? value.toFixed(1) : '∞');

export function issueTitle(account) {
	return `Aleph credits low: ${account.name} (${days(account.runway.runwayDays)} days left)`;
}

export function marker(address) {
	return `<!-- aleph-credit-runway:${address.toLowerCase()} -->`;
}

export function issueBody(account) {
	const r = account.runway;
	const lines = [
		marker(account.address),
		`The Aleph account **${account.name}** (\`${account.address}\`) has **${days(r.runwayDays)} days** of credits left at its current burn — under the ${r.warnDays}-day threshold.`,
		'',
		'| | |',
		'|---|---|',
		`| Credit balance | ${credits(r.creditBalance)} |`,
		`| Burn per day | ${credits(r.burnPerDay)} (instances ${credits(r.instancesPerDay)}, storage ${credits(r.storagePerDay)}) |`,
		`| Days left | ${days(r.runwayDays)}${r.runsOutAt ? ` (around ${r.runsOutAt.toISOString().slice(0, 16).replace('T', ' ')} UTC)` : ''} |`,
		`| Credits for ${r.targetDays} days | ${credits(r.creditsForTarget)} — a top-up of about **${credits(r.topUpForTarget)}** |`,
		'',
	];
	if (account.instances.length) {
		lines.push('Running instances charged to this account:', '');
		for (const instance of account.instances) {
			lines.push(`- \`${instance.itemHash}\`${instance.name ? ` (${instance.name})` : ''}: ${instance.perSecond.toFixed(3)} credits/s = ${credits(instance.perSecond * 3600)}/h`);
		}
		lines.push('');
	}
	lines.push(
		'At 0 credits Aleph tears the instances down; a relay rebuilt from its image comes back without its configuration and has to be reconfigured by hand.',
		'',
		`Checked ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC by the [Aleph credit runway](../actions/workflows/aleph-credit-runway.yml) workflow. This issue closes itself once the runway is back above ${r.warnDays} days.`,
	);
	return lines.join('\n');
}

// --- Aleph API ---------------------------------------------------------------

async function getJson(url) {
	const response = await fetch(url, {
		headers: { 'User-Agent': 'relay-button-credit-runway', Accept: 'application/json' },
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) throw new Error(`GET ${url} answered ${response.status}`);
	return response.json();
}

async function aleph(hosts, path) {
	let lastError;
	for (const host of hosts) {
		try {
			return await getJson(`${host.replace(/\/+$/, '')}/api/v0${path}`);
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError;
}

async function listInstances(hosts, address) {
	const messages = [];
	for (let page = 1; ; page += 1) {
		const result = await aleph(hosts, `/messages.json?msgTypes=INSTANCE&addresses=${address}&pagination=200&page=${page}`);
		messages.push(...(result.messages ?? []));
		if (!result.messages?.length || messages.length >= (result.pagination_total ?? 0)) break;
	}
	return messages;
}

export async function checkAccount(hosts, account, options) {
	const balance = await aleph(hosts, `/addresses/${account.address}/balance`);
	const history = await aleph(hosts, `/addresses/${account.address}/credit_history?pagination=50`);
	const instances = [];
	for (const message of await listInstances(hosts, account.address)) {
		const status = (await aleph(hosts, `/messages/${message.item_hash}`)).status;
		if (status !== 'processed') continue;
		const price = await aleph(hosts, `/price/${message.item_hash}`);
		if (String(price.charged_address ?? '').toLowerCase() !== account.address.toLowerCase()) continue;
		const perSecond = instanceCreditsPerSecond(price);
		if (perSecond > 0) {
			instances.push({ itemHash: message.item_hash, name: message.content?.metadata?.name ?? '', perSecond });
		}
	}
	const runway = computeRunway({
		creditBalance: balance.credit_balance,
		instanceCreditsPerSecond: instances.map((instance) => instance.perSecond),
		storageCreditsPerHour: storageCreditsPerHour(history.credit_history),
		...options,
	});
	return { ...account, instances, runway };
}

// --- GitHub issues ------------------------------------------------------------

function github(token, repository) {
	return async (method, path, body) => {
		const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: 'application/vnd.github+json',
				'User-Agent': 'relay-button-credit-runway',
				'X-GitHub-Api-Version': '2022-11-28',
			},
			body: body ? JSON.stringify(body) : undefined,
		});
		if (method === 'POST' && path === '/labels' && response.status === 422) return null; // exists
		if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`);
		return response.status === 204 ? null : response.json();
	};
}

async function syncIssue(api, openIssues, account) {
	const existing = openIssues.find((issue) => issue.body?.includes(marker(account.address)));
	const r = account.runway;
	if (r.low) {
		const title = issueTitle(account);
		const body = issueBody(account);
		if (existing) {
			await api('PATCH', `/issues/${existing.number}`, { title, body });
			await api('POST', `/issues/${existing.number}/comments`, {
				body: `Still low: ${credits(r.creditBalance)} credits, ${credits(r.burnPerDay)} per day, ${days(r.runwayDays)} days left. About ${credits(r.topUpForTarget)} credits would cover ${r.targetDays} days.`,
			});
			return `updated #${existing.number}`;
		}
		const created = await api('POST', '/issues', { title, body, labels: [ISSUE_LABEL] });
		return `opened #${created.number}`;
	}
	if (existing) {
		await api('POST', `/issues/${existing.number}/comments`, {
			body: `Topped up: ${credits(r.creditBalance)} credits, ${credits(r.burnPerDay)} per day, ${days(r.runwayDays)} days left. Closing.`,
		});
		await api('PATCH', `/issues/${existing.number}`, { state: 'closed', state_reason: 'completed' });
		return `closed #${existing.number}`;
	}
	return 'no issue';
}

// --- main ---------------------------------------------------------------------

async function main() {
	const env = process.env;
	const accounts = parseAccounts(env.ALEPH_CREDIT_ACCOUNTS);
	const hosts = (env.ALEPH_API_HOSTS || 'https://api2.aleph.im,https://api.aleph.im').split(',').map((h) => h.trim()).filter(Boolean);
	const options = {
		warnDays: Number(env.RUNWAY_WARN_DAYS || 7),
		targetDays: Number(env.RUNWAY_TARGET_DAYS || 30),
	};
	if (!(options.warnDays > 0) || !(options.targetDays > 0)) {
		throw new Error('RUNWAY_WARN_DAYS and RUNWAY_TARGET_DAYS must be positive numbers.');
	}

	const api = env.GITHUB_TOKEN && env.GITHUB_REPOSITORY ? github(env.GITHUB_TOKEN, env.GITHUB_REPOSITORY) : null;
	let openIssues = [];
	if (api) {
		await api('POST', '/labels', { name: ISSUE_LABEL, color: 'd93f0b', description: 'An Aleph account is running out of credits' });
		openIssues = await api('GET', `/issues?state=open&labels=${ISSUE_LABEL}&per_page=100`);
	}

	const rows = [];
	let failed = 0;
	for (const account of accounts) {
		try {
			const checked = await checkAccount(hosts, account, options);
			const r = checked.runway;
			const action = api ? await syncIssue(api, openIssues, checked) : 'report only';
			rows.push(`| ${account.name} | ${credits(r.creditBalance)} | ${credits(r.burnPerDay)} | ${days(r.runwayDays)}${r.low ? ' ⚠️' : ''} | ${credits(r.topUpForTarget)} | ${action} |`);
			const line = `${account.name} (${account.address}): ${credits(r.creditBalance)} credits, ${credits(r.burnPerDay)}/day, ${days(r.runwayDays)} days left, ${credits(r.topUpForTarget)} more for ${r.targetDays} days — ${action}`;
			console.log(r.low ? `::warning::${line}` : line);
		} catch (error) {
			failed += 1;
			// A failed read never closes an issue: it leaves everything as it was.
			rows.push(`| ${account.name} | ? | ? | ? | ? | check failed |`);
			console.log(`::error::${account.name} (${account.address}): ${error.message}`);
		}
	}

	if (env.GITHUB_STEP_SUMMARY) {
		appendFileSync(
			env.GITHUB_STEP_SUMMARY,
			[
				`## Aleph credit runway (warn under ${options.warnDays} days)`,
				'',
				`| Account | Balance | Burn/day | Days left | Top-up for ${options.targetDays} days | Issue |`,
				'|---|---:|---:|---:|---:|---|',
				...rows,
				'',
			].join('\n'),
		);
	}
	if (failed) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
