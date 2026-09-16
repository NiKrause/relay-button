import test from "node:test"
import assert from "node:assert/strict"
import * as dagPb from "@ipld/dag-pb"
import { CID } from "multiformats/cid"
import * as raw from "multiformats/codecs/raw"
import { sha256 } from "multiformats/hashes/sha2"

import { fetchDagOverLibp2p, type Libp2pDagFetchNode } from "../src/site-libp2p.ts"

const PEER = '/ip4/127.0.0.1/tcp/4001/p2p/12D3KooWHWNCn8t9NKQPBPZU61Fq6BoVw9XV37YsWTuMLwZXrEtj'

async function siteDag() {
  const leafBytes = new TextEncoder().encode('<!doctype html><title>site</title>')
  const leaf = CID.createV1(raw.code, await sha256.digest(leafBytes))
  const rootBytes = dagPb.encode(dagPb.prepare({ Links: [{ Hash: leaf, Name: 'index.html', Tsize: leafBytes.byteLength }] }))
  const root = CID.createV1(dagPb.code, await sha256.digest(rootBytes))
  const blocks = new Map<string, Uint8Array>([[root.toString(), rootBytes], [leaf.toString(), leafBytes]])
  return { root, leaf, blocks }
}

function fakeNode(blocks: Map<string, Uint8Array>, options: { withhold?: string; failDial?: boolean } = {}) {
  const calls = { dials: [] as string[], sessions: [] as string[], gets: [] as string[], stopped: false }
  const node: Libp2pDagFetchNode = {
    libp2p: {
      async dial(address) {
        calls.dials.push(String(address))
        if (options.failDial) throw new Error('connection refused')
      },
      getConnections: () => [{}, {}],
    },
    blockstore: {
      createSession(root) {
        calls.sessions.push(String(root))
        return {
          async *get(cid) {
            calls.gets.push(String(cid))
            const bytes = blocks.get(String(cid))
            if (!bytes || String(cid) === options.withhold) throw new Error('Want was aborted')
            yield bytes
          },
        }
      },
    },
    async stop() {
      calls.stopped = true
    },
  }
  return { node, calls }
}

test('fetchDagOverLibp2p walks the DAG through one session and stops the node', async () => {
  const { root, leaf, blocks } = await siteDag()
  const { node, calls } = fakeNode(blocks)
  const result = await fetchDagOverLibp2p(
    { cid: root.toString(), expectedBlockCids: [leaf.toString(), root.toString()], peers: [PEER] },
    { createNode: async () => node },
  )
  assert.equal(result.blocks, 2)
  assert.equal(result.connectedPeers, 2)
  assert.deepEqual(calls.dials, [PEER])
  assert.deepEqual(calls.sessions, [root.toString()])
  assert.deepEqual(calls.gets.sort(), [leaf.toString(), root.toString()].sort())
  assert.equal(calls.stopped, true)
})

test('fetchDagOverLibp2p keeps going when an extra peer cannot be dialed', async () => {
  const { root, blocks } = await siteDag()
  const { node, calls } = fakeNode(blocks, { failDial: true })
  const logged: string[] = []
  const result = await fetchDagOverLibp2p(
    { cid: root.toString(), peers: [PEER], log: (message) => logged.push(message) },
    { createNode: async () => node },
  )
  assert.equal(result.blocks, 2)
  assert.match(logged.join('\n'), /libp2p dial to .* failed: connection refused/)
  assert.equal(calls.stopped, true)
})

test('fetchDagOverLibp2p fails when a block of the uploaded CAR is not part of the fetched DAG', async () => {
  const { root, blocks } = await siteDag()
  const stray = CID.createV1(raw.code, await sha256.digest(new TextEncoder().encode('not in the site')))
  const { node, calls } = fakeNode(blocks)
  await assert.rejects(
    fetchDagOverLibp2p({ cid: root.toString(), expectedBlockCids: [stray.toString()] }, { createNode: async () => node }),
    new RegExp(`lacks 1 expected block\\(s\\), for example ${stray.toString()}`),
  )
  assert.equal(calls.stopped, true)
})

test('fetchDagOverLibp2p fails when the network does not deliver a block', async () => {
  const { root, leaf, blocks } = await siteDag()
  const { node, calls } = fakeNode(blocks, { withhold: leaf.toString() })
  await assert.rejects(
    fetchDagOverLibp2p({ cid: root.toString() }, { createNode: async () => node }),
    /over libp2p failed after \d+ ms: Want was aborted/,
  )
  assert.equal(calls.stopped, true)
})
