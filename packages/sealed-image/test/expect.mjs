// The few matchers these tests use, in the shape of vitest's `expect`, over
// node:assert: the tests came from Paperless anywhere's vitest suite and
// keep their wording.
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';

const matchesObject = (actual, expected) => {
	if (expected && typeof expected === 'object' && !Array.isArray(expected) && !(expected instanceof Uint8Array)) {
		if (expected.__any) return expected.__any(actual);
		return actual !== null && typeof actual === 'object' && Object.entries(expected).every(([k, v]) => matchesObject(actual[k], v));
	}
	if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((v, i) => matchesObject(actual[i], v));
	return isDeepStrictEqual(actual, expected);
};
const throwsLike = (error, expected) => {
	if (expected === undefined) return;
	if (expected && typeof expected === 'object' && !(expected instanceof RegExp)) return assert.ok(matchesObject(error, expected), `expected ${JSON.stringify(expected)}, got ${error?.code} ${error?.message}`);
	if (typeof expected === 'function') return assert.ok(error instanceof expected, `expected a ${expected.name}, got ${error}`);
	const message = String(error?.message ?? error);
	if (expected instanceof RegExp) return assert.match(message, expected);
	assert.ok(message.includes(expected), `"${message}" does not contain "${expected}"`);
};

function matchers(actual, negate = false) {
	const check = (ok, what) => assert.ok(negate ? !ok : ok, `${negate ? 'not ' : ''}${what}: ${JSON.stringify(actual)?.slice(0, 300)}`);
	return {
		toBe: (e) => check(Object.is(actual, e), `toBe ${JSON.stringify(e)}`),
		toEqual: (e) => check(isDeepStrictEqual(actual, e) || matchesObject(actual, e), `toEqual ${JSON.stringify(e)?.slice(0, 300)}`),
		toMatchObject: (e) => check(matchesObject(actual, e), `toMatchObject ${JSON.stringify(e)?.slice(0, 300)}`),
		toBeUndefined: () => check(actual === undefined, 'toBeUndefined'),
		toBeNull: () => check(actual === null, 'toBeNull'),
		toContain: (e) => check(actual?.includes?.(e), `toContain ${JSON.stringify(e)}`),
		toHaveLength: (n) => check(actual?.length === n, `toHaveLength ${n}`),
		toMatch: (re) => check(re.test(actual), `toMatch ${re}`),
		toBeGreaterThan: (n) => check(actual > n, `toBeGreaterThan ${n}`),
		toBeGreaterThanOrEqual: (n) => check(actual >= n, `toBeGreaterThanOrEqual ${n}`),
		toBeLessThan: (n) => check(actual < n, `toBeLessThan ${n}`),
		toBeLessThanOrEqual: (n) => check(actual <= n, `toBeLessThanOrEqual ${n}`),
		toThrow: (e) => {
			let error = null;
			try {
				actual();
			} catch (x) {
				error = x;
			}
			assert.ok(error, 'expected a throw');
			throwsLike(error, e);
		}
	};
}

export function expect(actual) {
	return {
		...matchers(actual),
		not: matchers(actual, true),
		rejects: {
			toThrow: async (e) => {
				let error = null;
				try {
					await actual;
				} catch (x) {
					error = x;
				}
				assert.ok(error, 'expected a rejection');
				throwsLike(error, e);
			}
		}
	};
}
expect.any = (type) => ({ __any: (v) => (type === Number ? typeof v === 'number' : v instanceof type) });
