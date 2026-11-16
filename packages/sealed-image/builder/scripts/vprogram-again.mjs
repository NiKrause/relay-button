// Starts a builder again from the volumes of a published one, as an app's
// build starts it: does a second V-PROGRAM on the very same volumes get the
// same launch measurement? The measured boot line holds the runtime, the
// workload's and the volumes' root hashes and the resources, not the
// message's own hash, so it should (Le-Space/paperless-anywhere#202).
//
//   FROM=<hash>   copies the content of that V-PROGRAM (still processed, sent
//                 by this key) with a new time;
//   FROM=fixed    takes `program` from the publication file PUBLICATION
//                 (builder/publications/<app>.json), exactly as an app's
//                 build starts it.
//
// Signed with ALEPH_PRIVATE_KEY and published; Aleph's scheduler starts it.
// Nothing is uploaded. Writes the result to AGAIN_RESULT when set. The new
// V-PROGRAM costs credits until it is deleted.
//
//   FROM=fixed PUBLICATION=builder/publications/x.json ALEPH_PRIVATE_KEY=… node builder/scripts/vprogram-again.mjs
import { readFile, writeFile } from 'node:fs/promises';
import { privateKeyToAccount } from 'viem/accounts';
import { ALEPH_API, broadcast, sha256Hex, templateMismatches } from '@le-space/aleph-vm';
import { signAlephMessage } from '@le-space/core';

const { FROM = '', PUBLICATION = '', ALEPH_PRIVATE_KEY = '', AGAIN_RESULT = '', ALEPH_CHANNEL = 'sealed-image-builder' } = process.env;
const fixed = FROM === 'fixed';
if (!fixed && !/^[0-9a-f]{64}$/.test(FROM)) throw new Error('FROM: 64 hex, or "fixed" with PUBLICATION');
const key = ALEPH_PRIVATE_KEY.trim();
if (!key) throw new Error('ALEPH_PRIVATE_KEY is empty');
const account = privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`);

let content;
let channel = ALEPH_CHANNEL;
if (fixed) {
	if (!/^[\w./-]+\.json$/.test(PUBLICATION)) throw new Error('PUBLICATION: the path of a publication file');
	const publication = JSON.parse(await readFile(PUBLICATION, 'utf8'));
	const wrong = templateMismatches(publication);
	if (wrong.length) throw new Error(`${PUBLICATION} does not agree with itself: ${wrong.join(', ')}`);
	content = { ...publication.program, address: account.address };
} else {
	const original = await (await fetch(`${ALEPH_API}/api/v0/messages/${FROM}`)).json();
	const message = original?.message;
	if (original?.status !== 'processed' || message?.type !== 'V-PROGRAM') throw new Error(`${FROM} is no processed V-PROGRAM (${original?.status})`);
	if (message.sender.toLowerCase() !== account.address.toLowerCase()) throw new Error(`${FROM} was sent by ${message.sender}, not by this key`);
	content = typeof message.item_content === 'string' ? JSON.parse(message.item_content) : message.content;
	channel = message.channel ?? channel;
}
if (!content?.verification?.measurements?.length) throw new Error(`${FROM} names no measurements`);

const again = { ...content, time: Date.now() / 1000, metadata: { ...content.metadata, name: `${content.metadata?.name ?? 'builder'}-again` } };
const itemContent = JSON.stringify(again);
const unsigned = { sender: account.address, chain: 'ETH', type: 'V-PROGRAM', item_hash: await sha256Hex(itemContent), item_type: 'inline', item_content: itemContent, time: again.time, channel };
const signed = await signAlephMessage(unsigned, (_sender, payload) => account.signMessage({ message: payload }));
const { httpStatus, response } = await broadcast(signed);
const result = {
	from: FROM,
	again: signed.item_hash,
	httpStatus,
	status: response?.message_status ?? response?.status ?? null,
	measurements: again.verification.measurements.map((m) => m?.registers?.launch)
};
console.log(JSON.stringify(result, null, 1));
if (AGAIN_RESULT) await writeFile(AGAIN_RESULT, JSON.stringify(result));
process.exit(httpStatus < 300 ? 0 : 1);
