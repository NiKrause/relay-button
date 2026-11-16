// An attested channel to a confidential VM through an attest relay
// (@le-space/attest-relay), opened with @le-space/attest-wasm's RA-TLS
// handshake: it completes only for the measurements and the policy given.
// Everything that does the attesting is handed in, so this module loads no
// WASM itself and runs the same in a browser and in Node.
import { AlephVmError } from './aleph.mjs';

const decoder = new TextDecoder();

/**
 * @typedef {{
 *   request: (method: string, path: string, init?: { headers?: Record<string, string>, body?: string | Uint8Array }) => Promise<{ status: number, body: Uint8Array }>,
 *   close: () => void,
 *   relay?: string,
 *   measurement?: string
 * }} Channel
 */

/** An attestation that was refused: nothing is retried after that. @param {unknown} error */
export const refusedAttestation = (error) => /rejected|measurement|policy|signature/i.test(String(error instanceof Error ? error.message : error));

/** The host of a relay (wss://host/attest or a multiaddr's dns part), for showing; never its path. @param {string} relay */
export function relayHost(relay) {
	try {
		return new URL(relay).host;
	} catch {
		return /\/dns[46]?\/([^/]+)/.exec(String(relay))?.[1] ?? '';
	}
}

/**
 * One JSON call over a channel: `{ status, answer }`, `answer` null when the
 * body is no JSON.
 * @param {Channel} channel @param {string} method @param {string} path @param {any} [body]
 */
export async function callJson(channel, method, path, body) {
	const response = await channel.request(method, path, body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
	let answer = null;
	try {
		answer = JSON.parse(decoder.decode(response.body));
	} catch {
		/* no JSON: the status says enough */
	}
	return { status: response.status, answer };
}

/**
 * A function that opens an attested channel to the VM at `target.route` over
 * one of `relays`. It is meant to be called many times (a relay carries only
 * so much per connection), so it begins with the relay that carried the last
 * one. A refused attestation is thrown as it is; when no relay reaches the
 * VM, the error has code `unreachable`.
 *
 * `load` resolves (once) to what attests: `attestGuest` from
 * `@le-space/attest-wasm/ratls`, the loaded `wasm`, `relays` (attest relay
 * URLs or multiaddrs) and `relayTransports(relays)(route)`, which makes the
 * transport for a route over those relays.
 * @param {{ route: string, measurements: string[], policy: number | string }} target
 * @param {() => Promise<{ attestGuest: (a: any) => Promise<any>, relayTransports: (relays: string[]) => (route: string) => any, relays: string[], wasm: any }>} load
 * @returns {() => Promise<Channel>}
 */
export function attestedOpener(target, load) {
	let loaded = null;
	let good = 0;
	return async () => {
		loaded ??= load();
		const { attestGuest, relayTransports, relays, wasm } = await loaded;
		if (!relays?.length) throw new AlephVmError('no attest relay to reach the VM through', 'no-relay');
		let last = null;
		for (let i = 0; i < relays.length; i++) {
			const index = (good + i) % relays.length;
			try {
				const attested = await attestGuest({ wasm, transport: relayTransports([relays[index]])(target.route), expectedMeasurements: target.measurements, expectedPolicy: target.policy });
				good = index;
				const measurement = attested.freshVerified?.measurement;
				return Object.assign(attested.channel, { relay: relayHost(relays[index]) }, measurement ? { measurement: String(measurement) } : {});
			} catch (error) {
				if (refusedAttestation(error)) throw error;
				last = error;
			}
		}
		const why = String(last instanceof Error ? last.message : last).slice(0, 120);
		throw new AlephVmError(`the VM could not be reached through any attest relay: ${why}`, 'unreachable', { last: why });
	};
}
