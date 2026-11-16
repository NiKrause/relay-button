// A measured V-PROGRAM started for one piece of work and forgotten after it.
//
// The app pins a V-PROGRAM's content (`program`: runtime, workload and
// volumes with their root hashes, resources, the node, the measurements),
// not a running VM: the measured boot line holds the runtime, the root
// hashes and the resources, not the message's own hash, so every V-PROGRAM
// with that content shows the same measurement (tried on Aleph, 2026-11-14,
// Le-Space/paperless-anywhere#202). The volumes stay published; what a run
// starts, the V-PROGRAM, it forgets again, also when the work fails.
import { AlephVmError, poster, sha256Hex } from './aleph.mjs';
import { callJson, refusedAttestation } from './attest.mjs';
import { HEX64, forgetMessage } from './vm.mjs';
import { signAlephMessage } from '@le-space/core';

/** @typedef {import('./vm.mjs').AppKey} AppKey */
/** @typedef {import('./attest.mjs').Channel} Channel */
/**
 * A V-PROGRAM fixed by its content and the node that runs it.
 * @typedef {{ program: Record<string, any>, crn: string, measurements: string[], policy: number | string }} VProgramTemplate
 */

const sleeper = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The template if it is complete: content with `verification`, the node
 * (64 hex), measurements and the policy; else an error with code `no-template`.
 * @template {VProgramTemplate} T @param {T} template @returns {T}
 */
export function checkTemplate(template) {
	if (!template?.program?.verification || !HEX64.test(template.crn ?? '') || !template.measurements?.length || template.policy == null) {
		throw new AlephVmError('no complete V-PROGRAM template (program with verification, crn, measurements, policy)', 'no-template');
	}
	return template;
}

/**
 * Whether the template's content names exactly the measurements, policy and
 * node it pins beside it, and no address or time of one publication.
 * @param {VProgramTemplate} template @returns {string[]} what does not hold; empty when all does
 */
export function templateMismatches(template) {
	const p = template?.program ?? {};
	const out = [];
	const launches = (p.verification?.measurements ?? []).map((m) => m?.registers?.launch);
	if (JSON.stringify(launches) !== JSON.stringify(template?.measurements ?? [])) out.push('measurements');
	if (p.verification?.policy !== template?.policy) out.push('policy');
	if (p.requirements?.node?.node_hash !== template?.crn) out.push('crn');
	for (const v of [p.workload, ...(p.volumes ?? [])]) for (const h of [v?.ref, v?.hash_tree, v?.roothash]) if (!HEX64.test(h ?? '')) out.push('volumes');
	if ('address' in p) out.push('address');
	if ('time' in p) out.push('time');
	return [...new Set(out)];
}

/**
 * The V-PROGRAM message for one run: the fixed content with the payer's
 * address and the time, signed by the app's key.
 * @param {AppKey} app @param {VProgramTemplate} template
 * @param {{ channel: string, time?: number, payer?: string }} o
 */
export async function vprogramMessage(app, template, { channel, time = Date.now() / 1000, payer = app.address }) {
	checkTemplate(template);
	const item_content = JSON.stringify({ ...template.program, address: payer, time });
	const unsigned = { sender: app.address, chain: 'ETH', type: 'V-PROGRAM', item_hash: await sha256Hex(item_content), item_type: 'inline', item_content, time, channel };
	return signAlephMessage(unsigned, (_sender, payload) => app.signMessage({ message: payload }));
}

/**
 * Forget a V-PROGRAM, a few times. True when Aleph took the FORGET.
 * @param {AppKey} app @param {string} vprogram
 * @param {{ channel: string, reason?: string, payer?: string, post?: (m: any) => Promise<any>, sleep?: (ms: number) => Promise<void>, tries?: number, retryMs?: number }} o
 */
export async function forgetVProgram(app, vprogram, { channel, reason = 'run ended', payer = app.address, post = poster(), sleep = sleeper, tries = 4, retryMs = 5000 }) {
	for (let attempt = 0; attempt < tries; attempt++) {
		if (attempt) await sleep(retryMs * attempt);
		try {
			await post(await forgetMessage(app, [vprogram], { channel, reason, payer }));
			return true;
		} catch {
			/* tried again; the caller keeps it for later otherwise */
		}
	}
	return false;
}

/** The default readiness check: `GET /` answers 200 with a JSON `service`. @param {Channel} channel */
export const answersWithService = async (channel) => {
	const hello = await callJson(channel, 'GET', '/');
	return hello.status === 200 && Boolean(hello.answer?.service);
};

/**
 * Start a V-PROGRAM from `template`, wait until it answers attested, hand it
 * to `work`, and forget it afterwards, whatever happened.
 *
 * The caller notes the V-PROGRAM between start and forget (`onStarted`,
 * `onForgotten`), so a closed window leaves nothing running for longer than
 * the next opening (forget it then with `forgetVProgram`). A V-PROGRAM Aleph
 * refused (no credits) is neither noted nor forgotten.
 *
 * `opener(running)` makes the function that opens attested channels to the
 * running V-PROGRAM (`attestedOpener` with `running.route`). The node starts
 * it within minutes (about four, 2026-11-14), and the guest attests before
 * its workload is up (its proxy answers 503 "upstream not ready" until then),
 * so it counts as up once `ready(channel)` is true. The first channel that
 * was ready is the first `open()` hands to `work`.
 * @template R
 * @param {{
 *   app: AppKey, template: VProgramTemplate, channel: string, payer?: string,
 *   opener: (running: VProgramTemplate & { route: string, vprogram: string }) => () => Promise<Channel>,
 *   work: (a: { open: () => Promise<Channel>, running: VProgramTemplate & { route: string, vprogram: string }, vprogram: string }) => Promise<R>,
 *   ready?: (channel: Channel) => Promise<boolean>,
 *   onStarted?: (vprogram: string) => Promise<void> | void,
 *   onForgotten?: (vprogram: string) => Promise<void> | void,
 *   onProgress?: (p: { step: 'start', data?: Record<string, any> }) => void,
 *   post?: (message: any) => Promise<any>, sleep?: (ms: number) => Promise<void>,
 *   upTries?: number, upMs?: number, reason?: string
 * }} a
 * @returns {Promise<R>}
 */
export async function runOnFreshVProgram({ app, template, channel, payer = app.address, opener, work, ready = answersWithService, onStarted = () => {}, onForgotten = () => {}, onProgress = () => {}, post = poster(), sleep = sleeper, upTries = 40, upMs = 15_000, reason = 'run ended' }) {
	checkTemplate(template);
	onProgress({ step: 'start' });
	const message = await vprogramMessage(app, template, { channel, payer });
	const vprogram = String(message.item_hash);
	let accepted = false;
	try {
		await post(message);
		accepted = true;
		onProgress({ step: 'start', data: { vprogram, node: template.crn } });
		await onStarted(vprogram);
		const running = { ...template, route: `?crn=${template.crn}&vm=${vprogram}`, vprogram };
		const open = opener(running);
		let first = null;
		for (let i = 0; !first; i++) {
			try {
				const c = await open();
				if (await ready(c)) first = c;
				else c.close?.();
			} catch (error) {
				if (refusedAttestation(error) || /** @type {any} */ (error)?.code !== 'unreachable') throw error;
			}
			if (first) break;
			if (i + 1 >= upTries) throw new AlephVmError('the V-PROGRAM did not come up', 'unreachable', { last: 'not up' });
			await sleep(upMs);
		}
		let handed = false;
		const openFirst = () => (handed ? open() : ((handed = true), Promise.resolve(first)));
		return await work({ open: openFirst, running, vprogram });
	} finally {
		if (accepted && (await forgetVProgram(app, vprogram, { channel, reason, payer, post, sleep }))) await onForgotten(vprogram);
	}
}
