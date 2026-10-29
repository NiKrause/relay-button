// Publish an encrypted rootfs on Aleph: one POST to an API node's
// /api/v0/ipfs/add_file with the signed STORE message beside the file.
//
// Since 2026-10-26 Aleph's IPFS hosts (ipfs.aleph.cloud, ipfs-2.aleph.im,
// ipfs.aleph.im) answer every /api/v0/ call with 404. The API node takes up to
// 1 GiB when a signed STORE message goes with the file (25 MiB without) and
// keeps it in the same call. It checks after pinning that the CID it made is
// the one the message names, so the CID is computed here first, the way
// `ipfs add` does by default (as NiKrause/orbitdb-storage-bridge 0.27.0 does).
//
//   ALEPH_PRIVATE_KEY=… ALEPH_API=https://api2.aleph.im CHANNEL=… \
//     node publish-store.mjs <file>   → prints {"item_hash","cid","status"}
// Needs ethers@6 and ipfs-unixfs-importer@17 next to it (npm install).
import { createHash } from 'node:crypto'
import { createReadStream, openAsBlob, statSync } from 'node:fs'
import { Wallet } from 'ethers'
import { importer } from 'ipfs-unixfs-importer'

const file = process.argv[2]
if (!file) throw new Error('usage: node publish-store.mjs <file>')
const api = (process.env.ALEPH_API || 'https://api2.aleph.im').replace(/\/+$/, '')
const channel = process.env.CHANNEL || 'ALEPH-CLOUDSOLUTIONS'
const size = statSync(file).size
if (size > 1024 * 1024 * 1024) throw new Error(`the file has ${size} bytes; Aleph takes at most 1 GiB in one upload`)

/** `ipfs add` defaults: CIDv0, dag-pb leaves, 256 KiB chunks, a balanced tree of 174 links. */
export async function unixfsCid(path) {
  const sink = { put: async (cid) => cid, get: async () => { throw new Error('no blocks kept') }, has: async () => false }
  let last
  for await (const entry of importer([{ content: createReadStream(path) }], sink, { cidVersion: 0, rawLeaves: false, reduceSingleLeafToSelf: true })) last = entry
  return last.cid.toString()
}

const cid = await unixfsCid(file)
console.error(`cid: ${cid}`)
const wallet = new Wallet(process.env.ALEPH_PRIVATE_KEY)
const time = Date.now() / 1000
const content = { address: wallet.address, time, item_type: 'ipfs', item_hash: cid, payment: { type: 'credit' } }
const item_content = JSON.stringify(content)
const item_hash = createHash('sha256').update(item_content).digest('hex')
const message = { sender: wallet.address, chain: 'ETH', type: 'STORE', item_hash, item_type: 'inline', item_content, time, channel }
const signature = await wallet.signMessage([message.chain, message.sender, message.type, message.item_hash].join('\n'))

const form = new FormData()
form.append('file', await openAsBlob(file), 'rootfs')
form.append('metadata', JSON.stringify({ message: { ...message, signature }, sync: true }))
const res = await fetch(`${api}/api/v0/ipfs/add_file`, { method: 'POST', body: form, signal: AbortSignal.timeout(3600_000) })
const text = await res.text()
console.error(`add_file answered ${res.status}: ${text.slice(0, 300)}`)
if (!res.ok) throw new Error(`add_file answered ${res.status}`)
const answered = (() => { try { return JSON.parse(text)?.hash } catch { return null } })()
if (answered && answered !== cid) throw new Error(`the node made CID ${answered}, the message names ${cid}`)
console.log(JSON.stringify({ item_hash, cid, status: res.status }))
