import { bitswap } from "@helia/block-brokers"
import { libp2pRouting } from "@helia/routers"
import * as dagPb from "@ipld/dag-pb"
import { multiaddr } from "@multiformats/multiaddr"
import { MemoryBlockstore } from "blockstore-core"
import { MemoryDatastore } from "datastore-core"
import { createHelia, libp2pDefaults } from "helia"
import { createLibp2p } from "libp2p-helia"
import { CID } from "multiformats/cid"

/**
 * IPFS nodes run by Aleph: DHT servers that hold what Aleph pins. Dialing them
 * reaches the IPFS network without the public bootstrap nodes, which Shipyard
 * stops operating on 30 September 2026. Each of them alone was enough to find
 * providers and fetch a pinned site with those bootstrap nodes refused.
 */
export const ALEPH_IPFS_PEERS: readonly string[] = [
  '/dns4/ipfs-2.aleph.im/tcp/4001/p2p/12D3KooWACE5dRw5V9WXuDTcngjE3ZaDSZ4qYJGfuhXZbENnL54y',
  '/ip4/46.255.204.220/tcp/4001/p2p/12D3KooWJBw9CSUWQi7P7amZsjrsBAzoB2gJzyUUGkuBkdLc87co',
  '/ip4/46.255.204.193/tcp/4001/p2p/12D3KooWDDLF8wFXnSpwtxSek3E3zwYueKgPyxLAdokXemnmBbgx',
]

export interface Libp2pDagFetchOptions {
  /** Root of the DAG to fetch. */
  cid: string
  /** Blocks the DAG must contain, for example every block of the CAR that was uploaded. */
  expectedBlockCids?: readonly string[]
  /** Multiaddrs to dial before fetching, in addition to Helia's bootstrap peers. Defaults to ALEPH_IPFS_PEERS. */
  peers?: readonly string[]
  /** Time allowed for the whole DAG. */
  timeoutMs?: number
  /** Time allowed for each extra dial. */
  dialTimeoutMs?: number
  log?: (message: string) => void
}

export interface Libp2pDagFetchResult {
  cid: string
  blocks: number
  connectedPeers: number
  durationMs: number
}

type BlockBytes = Uint8Array | AsyncIterable<Uint8Array> | Iterable<Uint8Array>

/** The part of a Helia node the fetch uses. */
export interface Libp2pDagFetchNode {
  libp2p: {
    dial(address: any, options?: { signal?: AbortSignal }): Promise<unknown>
    getConnections(): unknown[]
  }
  blockstore: {
    createSession(root: any, options?: { signal?: AbortSignal }): {
      get(cid: any, options?: { signal?: AbortSignal }): BlockBytes | Promise<BlockBytes>
    }
  }
  stop(): Promise<void>
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function toBytes(value: BlockBytes | Promise<BlockBytes>): Promise<Uint8Array> {
  const resolved = await value
  if (resolved instanceof Uint8Array) return resolved
  const chunks: Uint8Array[] = []
  for await (const chunk of resolved) chunks.push(chunk)
  const bytes = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/**
 * A standard Helia node that reaches IPFS content over libp2p only.
 *
 * Everything comes from `libp2pDefaults()` and `createHelia()` except the parts
 * that go through HTTP infrastructure or change the local network:
 * - no trustless gateway block broker and no HTTP gateway routing,
 * - no delegated routing client (HTTP),
 * - no AutoTLS (certificates are requested over HTTP),
 * - no UPnP (would open ports on the router).
 */
export async function createHeliaWithoutHttp(): Promise<Libp2pDagFetchNode> {
  const datastore = new MemoryDatastore()
  const libp2pOptions = libp2pDefaults() as any
  delete libp2pOptions.services.delegatedRouting
  delete libp2pOptions.services.autoTLS
  delete libp2pOptions.services.upnp
  const libp2p = await createLibp2p({ ...libp2pOptions, datastore })
  const helia = await createHelia({
    libp2p,
    datastore,
    blockstore: new MemoryBlockstore(),
    blockBrokers: [bitswap()],
    routers: [libp2pRouting(libp2p)],
  } as any)
  return helia as unknown as Libp2pDagFetchNode
}

/**
 * Fetches every block of a UnixFS DAG from the IPFS network over libp2p into an
 * empty in-memory node. Helia checks each block against its CID, so a completed
 * fetch shows that the network serves exactly this content.
 *
 * One session finds the providers of the root once and asks them for every
 * block, directories in parallel. Fetching block by block instead (as
 * `pins.add` does) searches again for each block: 57 blocks took 112 s that way
 * against 4 s with a session.
 */
export async function fetchDagOverLibp2p(
  options: Libp2pDagFetchOptions,
  dependencies: { createNode?: () => Promise<Libp2pDagFetchNode> } = {},
): Promise<Libp2pDagFetchResult> {
  const log = options.log ?? ((message: string) => console.warn(message))
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000
  const dialTimeoutMs = options.dialTimeoutMs ?? 30 * 1000
  const root = CID.parse(options.cid)
  const started = Date.now()
  const node = await (dependencies.createNode ?? createHeliaWithoutHttp)()

  try {
    const peers = options.peers ?? ALEPH_IPFS_PEERS
    await Promise.all(peers.map(async (address) => {
      try {
        await node.libp2p.dial(multiaddr(address), { signal: AbortSignal.timeout(dialTimeoutMs) })
      } catch (error) {
        log(`libp2p dial to ${address} failed: ${describe(error)}`)
      }
    }))

    const signal = AbortSignal.timeout(timeoutMs)
    const session = node.blockstore.createSession(root, { signal })
    const fetched = new Set<string>()
    const walk = async (cid: CID): Promise<void> => {
      const key = cid.toV1().toString()
      if (fetched.has(key)) return
      fetched.add(key)
      const bytes = await toBytes(session.get(cid, { signal }))
      if (cid.code === dagPb.code) {
        await Promise.all(dagPb.decode(bytes).Links.map((link) => walk(link.Hash)))
      }
    }
    try {
      await walk(root)
    } catch (error) {
      throw new Error(
        `Fetching ${options.cid} over libp2p failed after ${Date.now() - started} ms: ${describe(error)}`,
        { cause: error },
      )
    }

    const missing = (options.expectedBlockCids ?? [])
      .map((cid) => CID.parse(cid).toV1().toString())
      .filter((cid) => !fetched.has(cid))
    if (missing.length > 0) {
      throw new Error(
        `The DAG fetched for ${options.cid} over libp2p lacks ${missing.length} expected block(s), for example ${missing[0]}.`,
      )
    }

    return {
      cid: options.cid,
      blocks: fetched.size,
      connectedPeers: node.libp2p.getConnections().length,
      durationMs: Date.now() - started,
    }
  } finally {
    await node.stop()
  }
}
