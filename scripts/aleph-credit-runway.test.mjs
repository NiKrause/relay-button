// Runway arithmetic with made-up numbers; no network.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
	computeRunway,
	instanceCreditsPerSecond,
	issueBody,
	marker,
	parseAccounts,
	storageCreditsPerHour,
} from './aleph-credit-runway.mjs';

test('runway is balance over instance plus storage burn per day', () => {
	// 2 credits/s = 172,800/day; 100/h storage = 2,400/day; 175,200/day in all.
	const r = computeRunway({
		creditBalance: 876_000,
		instanceCreditsPerSecond: [1.5, 0.5],
		storageCreditsPerHour: 100,
		warnDays: 7,
		targetDays: 30,
	});
	assert.equal(r.instancesPerDay, 172_800);
	assert.equal(r.storagePerDay, 2_400);
	assert.equal(r.burnPerDay, 175_200);
	assert.equal(r.runwayDays, 5);
	assert.equal(r.low, true);
	assert.equal(r.creditsForTarget, 5_256_000);
	assert.equal(r.topUpForTarget, 5_256_000 - 876_000);
});

test('a runway at or above the threshold is not low and needs no top-up past the target', () => {
	// 1,000/h storage only = 24,000/day; 30 days need 720,000.
	const r = computeRunway({ creditBalance: 440_000, instanceCreditsPerSecond: [], storageCreditsPerHour: 1_000, warnDays: 7, targetDays: 30 });
	assert.equal(r.burnPerDay, 24_000);
	assert.ok(Math.abs(r.runwayDays - 18.333) < 0.01);
	assert.equal(r.low, false);
	assert.equal(r.creditsForTarget, 720_000);
	assert.equal(r.topUpForTarget, 280_000);

	const exactly = computeRunway({ creditBalance: 168_000, storageCreditsPerHour: 1_000, warnDays: 7 });
	assert.equal(exactly.runwayDays, 7);
	assert.equal(exactly.low, false);

	const flush = computeRunway({ creditBalance: 1_000_000, storageCreditsPerHour: 1_000, targetDays: 30 });
	assert.equal(flush.topUpForTarget, 0);
});

test('an empty account has zero runway, an account that burns nothing has an endless one', () => {
	const empty = computeRunway({ creditBalance: 0, instanceCreditsPerSecond: [1] });
	assert.equal(empty.runwayDays, 0);
	assert.equal(empty.low, true);

	const idle = computeRunway({ creditBalance: 500, instanceCreditsPerSecond: [], storageCreditsPerHour: 0 });
	assert.equal(idle.runwayDays, Number.POSITIVE_INFINITY);
	assert.equal(idle.low, false);
	assert.equal(idle.runsOutAt, null);
});

test('storage burn averages the newest hourly storage expenses only', () => {
	const history = [
		{ payment_method: 'credit_expense', origin_ref: 'storage', amount: -300, message_timestamp: '2030-01-01T03:00:00Z' },
		{ payment_method: 'credit_expense', origin_ref: 'abc', origin: 'instance', amount: -9_999, message_timestamp: '2030-01-01T02:30:00Z' },
		{ payment_method: 'credit_expense', origin_ref: 'storage', amount: -200, message_timestamp: '2030-01-01T02:00:00Z' },
		{ payment_method: 'credit_transfer', origin_ref: null, amount: 5_000_000, message_timestamp: '2030-01-01T01:30:00Z' },
		{ payment_method: 'credit_expense', origin_ref: 'storage', amount: -100, message_timestamp: '2030-01-01T01:00:00Z' },
		// Older and much larger: a STORE forgotten since must not count any more.
		{ payment_method: 'credit_expense', origin_ref: 'storage', amount: -90_000, message_timestamp: '2030-01-01T00:00:00Z' },
	];
	assert.equal(storageCreditsPerHour(history), 200);
	assert.equal(storageCreditsPerHour(history, 1), 300);
	assert.equal(storageCreditsPerHour([]), 0);
});

test('instance price sums the credit cost of every part, discounts included', () => {
	const price = {
		payment_type: 'credit',
		cost: '2.5',
		detail: [
			{ name: 'instance', cost_credit: '2.5' },
			{ name: 'EXECUTION_INSTANCE_VOLUME_ROOTFS', cost_credit: '1.25' },
			{ name: 'EXECUTION_VOLUME_DISCOUNT', cost_credit: '-1.25' },
		],
	};
	assert.equal(instanceCreditsPerSecond(price), 2.5);
	assert.equal(instanceCreditsPerSecond({ payment_type: 'credit', cost: '0.75' }), 0.75);
	assert.equal(instanceCreditsPerSecond({ payment_type: 'hold', cost: '2.5', detail: [{ cost_credit: '2.5' }] }), 0);
});

test('accounts are read one per line, with comments', () => {
	const accounts = parseAccounts(`
		# who pays for what
		alpha 0x1111111111111111111111111111111111111111
		beta  0x2222222222222222222222222222222222222222  # second one
	`);
	assert.deepEqual(accounts, [
		{ name: 'alpha', address: '0x1111111111111111111111111111111111111111' },
		{ name: 'beta', address: '0x2222222222222222222222222222222222222222' },
	]);
	assert.deepEqual(
		parseAccounts('alpha 0x1111111111111111111111111111111111111111, beta 0x2222222222222222222222222222222222222222'),
		accounts,
	);
	assert.throws(() => parseAccounts('alpha not-an-address'), /expected/);
	assert.throws(() => parseAccounts('  # nothing\n'), /empty/);
});

test('the issue names the account, balance, burn, days left and the top-up for the target', () => {
	const address = '0x3333333333333333333333333333333333333333';
	const body = issueBody({
		name: 'gamma',
		address,
		instances: [{ itemHash: 'f'.repeat(64), name: 'relay', perSecond: 1 }],
		runway: computeRunway({ creditBalance: 172_800, instanceCreditsPerSecond: [1], warnDays: 7, targetDays: 30 }),
	});
	assert.ok(body.startsWith(marker(address)));
	assert.match(body, /\*\*gamma\*\*/);
	assert.match(body, /Credit balance \| 172,800 /);
	assert.match(body, /Burn per day \| 86,400 /);
	assert.match(body, /Days left \| 2\.0/);
	assert.match(body, /Credits for 30 days \| 2,592,000 — a top-up of about \*\*2,419,200\*\*/);
	assert.match(body, /1\.000 credits\/s = 3,600\/h/);
});
