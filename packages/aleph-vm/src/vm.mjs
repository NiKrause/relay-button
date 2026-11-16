// A confidential INSTANCE on Aleph, started and stopped from the browser by
// an app's own key on behalf of a paying account: the INSTANCE, the port
// forward and the FORGET carry `address` = payer (who pays, who owns) and are
// signed by the app's key (sender). Aleph accepts that with the payer's
// authorization; the node writes the sender into the measured kernel command
// line, so the app's key is also the one that may unlock the VM.
//
// `app` is anything with `address` and `signMessage({ message })` (a viem
// local account, a wallet adapter). `channel` is the app's Aleph channel.
import {
	createInstanceContent,
	createPortForwardAggregateContent,
	createUnsignedAggregateMessage,
	createUnsignedForgetMessage,
	createUnsignedInstanceMessage,
	signAlephMessage,
	fetch2n6WebAccessUrl,
	notifyCrnAllocationWithRetry,
	eraseInstanceOnCrn
} from '@le-space/core';
import { recoverMessageAddress } from 'viem';
import { ALEPH_API, AlephVmError, poster, readFetch, sha256Hex } from './aleph.mjs';

/** @typedef {{ address: string, signMessage: (a: { message: string }) => Promise<string> }} AppKey */

/** The address that holds Aleph's node registry (the corechannel aggregate). */
export const CORECHANNEL = '0xa1B3bb7d2332383D96b7796B908fB7f7F3c2Be10';
export const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Sign `unsigned` (built with the payer as sender, so its content says
 * address = payer) as the app's key. The item hash covers the content only,
 * so changing the sender keeps it valid.
 * @param {any} unsigned @param {AppKey} app
 */
export async function signAsDelegate(unsigned, app) {
	return signAlephMessage({ ...unsigned, sender: app.address }, (_sender, payload) => app.signMessage({ message: payload }));
}

/** A node's https address from the corechannel aggregate. @param {string} crnHash @param {{ api?: string, fetch?: typeof fetch }} [o] */
export async function crnAddress(crnHash, { api = ALEPH_API, fetch: fetchImpl } = {}) {
	const res = await readFetch(`${api}/api/v0/aggregates/${CORECHANNEL}.json?keys=corechannel`, 'reading the nodes', { fetch: fetchImpl });
	const node = (await res.json())?.data?.corechannel?.resource_nodes?.find((n) => n.hash === crnHash);
	if (!node?.address?.startsWith('https://')) throw new AlephVmError(`node ${crnHash.slice(0, 12)} has no https address`, 'no-node');
	return node.address.replace(/\/+$/, '');
}

/** The account's Aleph credits. @param {string} address @param {{ api?: string, fetch?: typeof fetch }} [o] */
export async function credits(address, { api = ALEPH_API, fetch: fetchImpl } = {}) {
	const res = await readFetch(`${api}/api/v0/addresses/${address}/balance`, 'reading the balance', { fetch: fetchImpl });
	return Number((await res.json())?.credit_balance ?? 0);
}

/**
 * The INSTANCE for a confidential VM: address = payer, sender = app.
 * @param {{
 *   app: AppKey, payer: string, channel: string, name: string,
 *   rootfsItemHash: string, rootfsSizeMiB: number, vcpus: number, memoryMiB: number,
 *   crnHash: string, trustedExecution: any, sshPublicKey?: string, volumes?: any[]
 * }} a
 */
export async function instanceMessage(a) {
	const content = createInstanceContent({
		address: a.payer,
		name: a.name,
		// An encrypted rootfs ignores it; the INSTANCE format wants one key.
		sshPublicKey: a.sshPublicKey ?? 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIJpcGVycGxlc3MtYW55d2hlcmUtbm8tc3NoLWtleQ no-ssh-key',
		rootfsItemHash: a.rootfsItemHash,
		rootfsSizeMiB: a.rootfsSizeMiB,
		vcpus: a.vcpus,
		memoryMiB: a.memoryMiB,
		crnHash: a.crnHash,
		trustedExecution: a.trustedExecution
	});
	if (a.volumes?.length) content.volumes = a.volumes;
	const unsigned = await createUnsignedInstanceMessage({ sender: a.payer, content, hasher: sha256Hex, channel: a.channel });
	return signAsDelegate(unsigned, a.app);
}

/**
 * Credits per hour Aleph will charge for a message (INSTANCE, V-PROGRAM),
 * from its own price estimate (no signature needed). Null when Aleph cannot
 * be asked. @param {any} message @param {{ api?: string, fetch?: typeof fetch }} [o]
 */
export async function estimateCreditsPerHour(message, { api = ALEPH_API, fetch: fetchImpl = globalThis.fetch } = {}) {
	const { signature: _, ...unsigned } = message;
	const res = await fetchImpl(`${api}/api/v0/price/estimate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: unsigned }) }).catch(() => null);
	if (!res?.ok) return null;
	const perSecond = Number((await res.json().catch(() => null))?.cost);
	return perSecond > 0 ? Math.round(perSecond * 3600) : null;
}

/** Send a signed message and wait until Aleph processed it; returns its item hash. @param {any} message @param {{ post?: (m: any) => Promise<any> }} [o] */
export async function send(message, { post = poster() } = {}) {
	await post(message);
	return String(message.item_hash);
}

/**
 * Forward `ports` (default: 443 over TCP) for the instance, in the payer's
 * port-forwarding aggregate, signed by the app.
 * @param {AppKey} app @param {string} payer @param {string} instanceItemHash
 * @param {{ channel: string, ports?: { port: number, tcp: boolean, udp: boolean }[], post?: (m: any) => Promise<any> }} o
 */
export async function forwardPorts(app, payer, instanceItemHash, { channel, ports = [{ port: 443, tcp: true, udp: false }], post = poster() }) {
	const content = createPortForwardAggregateContent({ sender: payer, instanceItemHash, requestedPorts: ports });
	const unsigned = await createUnsignedAggregateMessage({ sender: payer, content, hasher: sha256Hex, channel });
	return post(await signAsDelegate(unsigned, app));
}

/** Ask the node to allocate the instance now. @param {string} crnUrl @param {string} itemHash @param {{ fetch?: typeof fetch }} [o] */
export async function notifyNode(crnUrl, itemHash, { fetch: fetchImpl = globalThis.fetch } = {}) {
	const result = await notifyCrnAllocationWithRetry({ crnUrl, itemHash, fetch: (u, i) => fetchImpl(u, i) });
	if (result.status === 'unconfirmed') throw new AlephVmError(`the node did not take the instance: ${result.reason ?? 'no reason given'}`, 'not-allocated');
	return result;
}

/** What the node lists for the execution, or null. */
async function execution(crnUrl, itemHash, fetchImpl) {
	const res = await fetchImpl(`${crnUrl}/v2/about/executions/list`, { cache: 'no-store' }).catch(() => null);
	if (!res?.ok) return null;
	return (await res.json().catch(() => ({})))?.[itemHash] ?? null;
}

/**
 * Where the VM's `port` is reached from IPv4: the node's address and the port
 * it maps to. Null until the node lists both.
 * @param {string} crnUrl @param {string} itemHash @param {{ port?: number, fetch?: typeof fetch }} [o]
 * @returns {Promise<{ ipv4: string, port: number } | null>}
 */
export async function publicAddress(crnUrl, itemHash, { port: inner = 443, fetch: fetchImpl = globalThis.fetch } = {}) {
	const net = (await execution(crnUrl, itemHash, fetchImpl))?.networking;
	const ipv4 = net?.host_ipv4;
	const port = Number(net?.mapped_ports?.[String(inner)]?.host);
	return typeof ipv4 === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(ipv4) && port > 0 && port < 65536 ? { ipv4, port } : null;
}

/** The VM's state on its node (running, stopping, …), or null when the node does not list it. @param {string} crnUrl @param {string} itemHash @param {{ fetch?: typeof fetch }} [o] */
export async function nodeState(crnUrl, itemHash, { fetch: fetchImpl = globalThis.fetch } = {}) {
	return (await execution(crnUrl, itemHash, fetchImpl))?.state ?? null;
}

// One DNS label: letters, digits and inner hyphens, at most 63 characters.
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const TWO_N6 = new RegExp(`^${LABEL}\\.2n6\\.me$`);
const DNS_NAME = new RegExp(`^(?:${LABEL}\\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$`);

/**
 * Whether `host` is a plain DNS name, with a port at most: no path, user or
 * IP literal. Check it before sending anything secret to a host.
 * @param {unknown} host
 */
export function validHost(host) {
	if (typeof host !== 'string') return false;
	const [, name, port] = /^([^:]*)(?::(\d{1,5}))?$/.exec(host) ?? [];
	return Boolean(name) && name.length <= 253 && DNS_NAME.test(name) && (port === undefined || (Number(port) > 0 && Number(port) < 65536));
}

/** The 2n6 name in what 2n6's API answers: one label under 2n6.me, or null. @param {unknown} raw a bare label, a host or an https URL */
export function twoN6Host(raw) {
	const host = String(raw ?? '').trim().toLowerCase().replace(/^https:\/\//, '').replace(/\/$/, '');
	const name = host.includes('.') ? host : `${host}.2n6.me`;
	return TWO_N6.test(name) ? name : null;
}

/** The instance's 2n6 hostname, once 2n6 knows it. @param {string} itemHash @param {{ fetch?: typeof fetch }} [o] */
export async function hostname(itemHash, { fetch: fetchImpl = globalThis.fetch } = {}) {
	const access = await fetch2n6WebAccessUrl(itemHash, { fetch: (u, i) => fetchImpl(u, i) }).catch(() => null);
	return twoN6Host(access?.subdomain ?? access?.url ?? '');
}

/**
 * The FORGET of `hashes` in the payer's name, signed by the app's key.
 * @param {AppKey} app @param {string[]} hashes
 * @param {{ channel: string, reason?: string, payer?: string, time?: number }} o
 */
export async function forgetMessage(app, hashes, { channel, reason = 'forgotten', payer = app.address, time = Date.now() / 1000 }) {
	const unsigned = await createUnsignedForgetMessage({ sender: payer, hashes, reason, hasher: sha256Hex, channel, now: time });
	return signAsDelegate(unsigned, app);
}

/**
 * FORGET the instance on behalf of the payer (the node then stops it).
 * Returns Aleph's answer and the FORGET's own item hash.
 * @param {AppKey} app @param {string} payer @param {string} itemHash
 * @param {{ channel: string, reason?: string, post?: (m: any) => Promise<any> }} o
 */
export async function forgetInstance(app, payer, itemHash, { channel, reason = 'stopped', post = poster() }) {
	const signed = await forgetMessage(app, [itemHash], { channel, reason, payer });
	return { ...(await post(signed)), itemHash: String(signed.item_hash) };
}

/**
 * Ask the node to stop and erase the VM now. A FORGET alone works too, but the
 * node notices it only minutes later (measured: about 4) and keeps the VM
 * running and its address answering meanwhile. Best effort: the FORGET stays.
 * @param {AppKey} app @param {string} itemHash @param {string} crnUrl @param {{ fetch?: typeof fetch }} [o]
 */
export async function eraseOnNode(app, itemHash, crnUrl, { fetch: fetchImpl = globalThis.fetch } = {}) {
	return eraseInstanceOnCrn({
		sender: app.address,
		signer: (_sender, payload) => app.signMessage({ message: payload }),
		instanceHash: itemHash,
		crnUrl,
		fetch: (u, i) => fetchImpl(u, i)
	}).catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
}

/**
 * The app's INSTANCEs: messages its key sent, whose name starts with
 * `namePrefix`, newest first, each with who pays it; only those of `payer`
 * when given. A start that was interrupted leaves one that no profile knows
 * about; this finds it too.
 * @param {string} appAddress
 * @param {{ payer?: string, namePrefix?: string, api?: string, fetch?: typeof fetch }} [o]
 */
export async function listInstances(appAddress, { payer, namePrefix = '', api = ALEPH_API, fetch: fetchImpl } = {}) {
	const url = new URL('/api/v0/messages.json', api);
	url.searchParams.set('msgTypes', 'INSTANCE');
	// `addresses` matches the sender only, never the address a delegate acts
	// for: ask for the app's own messages, then keep those for this payer.
	url.searchParams.set('addresses', appAddress);
	url.searchParams.set('message_statuses', 'processed,pending');
	url.searchParams.set('pagination', '50');
	const res = await readFetch(String(url), 'listing the VMs', { fetch: fetchImpl });
	if (!res.ok) throw new AlephVmError(`the list of VMs could not be read (${res.status})`, 'unreadable', { status: res.status });
	return ownInstances((await res.json()).messages ?? [], appAddress, { payer, namePrefix });
}

/**
 * Of Aleph's INSTANCE messages, those this app key sent, as rows.
 * @param {any[]} messages @param {string} appAddress @param {{ payer?: string, namePrefix?: string }} [o]
 */
export function ownInstances(messages, appAddress, { payer, namePrefix = '' } = {}) {
	const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
	return messages
		.filter((m) => same(m.sender, appAddress) && (!payer || same(m.content?.address, payer)) && String(m.content?.metadata?.name ?? '').startsWith(namePrefix))
		.map((m) => ({
			itemHash: String(m.item_hash),
			name: String(m.content?.metadata?.name ?? ''),
			createdAt: Math.round(Number(m.time) * 1000),
			crnHash: m.content?.requirements?.node?.node_hash ?? null,
			payer: String(m.content?.address ?? '')
		}))
		.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * The INSTANCE `itemHash` as this app key signed it, checked here (content
 * hash and signature), so a stop after adopting it pins the measurements the
 * app put in, not whatever an API answer says.
 * @param {string} appAddress @param {string} itemHash @param {{ api?: string, fetch?: typeof fetch }} [o]
 */
export async function ownInstance(appAddress, itemHash, { api = ALEPH_API, fetch: fetchImpl } = {}) {
	const res = await readFetch(`${api}/api/v0/messages/${itemHash}`, 'looking up the VM', { fetch: fetchImpl });
	if (!res.ok) throw new AlephVmError(`the VM ${itemHash.slice(0, 12)} could not be read (${res.status})`, 'unreadable', { status: res.status });
	return checkOwnInstance(appAddress, itemHash, (await res.json())?.message);
}

/** @param {string} appAddress @param {string} itemHash @param {any} m the message as Aleph returns it */
export async function checkOwnInstance(appAddress, itemHash, m) {
	if (m?.type !== 'INSTANCE' || m.item_hash !== itemHash || typeof m.item_content !== 'string') throw new AlephVmError('not an INSTANCE with inline content', 'no-instance');
	if ((await sha256Hex(m.item_content)) !== itemHash) throw new AlephVmError('the content does not match its item hash', 'content-mismatch');
	const signer = await recoverMessageAddress({ message: [m.chain, m.sender, m.type, m.item_hash].join('\n'), signature: m.signature });
	if (signer.toLowerCase() !== appAddress.toLowerCase()) throw new AlephVmError('not signed by this app key', 'not-ours');
	return JSON.parse(m.item_content);
}
