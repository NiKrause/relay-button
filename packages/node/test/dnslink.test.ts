import test from "node:test"
import assert from "node:assert/strict"

import { dnslinkCid, resolveDnslink, type DnsLookups } from "../src/dnslink.ts"

const CID_V1 = 'bafybeiab5vrtxat6w4pmynetb4g6x5iirj3dtpnz74pgdupansxehuh72m'

function lookups(overrides: Partial<Record<string, unknown>> & { ns?: Record<string, string[]>; txt?: string[][] }) {
  const calls: string[] = []
  const table: DnsLookups = {
    async resolveCname(name) {
      calls.push(`CNAME ${name}`)
      if (name === '_dnslink.app.example.com') return ['_dnslink.app.example.com.static.public.aleph.sh.']
      throw Object.assign(new Error('no CNAME'), { code: 'ENODATA' })
    },
    async resolveNs(name) {
      calls.push(`NS ${name}`)
      const servers = overrides.ns?.[name]
      if (!servers) throw Object.assign(new Error('no NS'), { code: 'ENODATA' })
      return servers
    },
    async resolve4(name) {
      calls.push(`A ${name}`)
      return ['192.0.2.53']
    },
    async resolveTxt(name, servers) {
      calls.push(`TXT ${name} @ ${servers.join(',') || 'system'}`)
      return overrides.txt ?? []
    },
  }
  return { table, calls }
}

test('resolveDnslink follows the CNAME and asks the nameservers of the target zone', async () => {
  const { table, calls } = lookups({
    ns: { 'public.aleph.sh': ['public.aleph.sh.'] },
    txt: [[`dnslink=/ipfs/${CID_V1}`], ['v=spf1 -all']],
  })
  const records = await resolveDnslink('app.example.com', table)
  assert.deepEqual(records, [`dnslink=/ipfs/${CID_V1}`])
  assert.ok(calls.includes('A public.aleph.sh'))
  assert.equal(calls.at(-1), 'TXT _dnslink.app.example.com.static.public.aleph.sh @ 192.0.2.53')
})

test('resolveDnslink uses the system resolver when no enclosing zone has NS records', async () => {
  const { table, calls } = lookups({ txt: [['dnslink=/ipfs/', CID_V1]] })
  const records = await resolveDnslink('app.example.com', table)
  assert.deepEqual(records, [`dnslink=/ipfs/${CID_V1}`])
  assert.equal(calls.at(-1), 'TXT _dnslink.app.example.com.static.public.aleph.sh @ system')
})

test('dnslinkCid reads /ipfs/ records as CIDv1 and ignores everything else', () => {
  assert.equal(dnslinkCid(`dnslink=/ipfs/${CID_V1}`), CID_V1)
  assert.equal(
    dnslinkCid('dnslink=/ipfs/QmR3u6JNpvpoGEKfepbKQ6QRpDma6kwbg1e6aa4yoW9gzM'),
    'bafybeibijbzrkewear2lkoylctlf6v4atsukit4c36dsxpeq4ndj66gqzi',
  )
  assert.equal(dnslinkCid('dnslink=/ipns/example.com'), null)
  assert.equal(dnslinkCid('dnslink=/ipfs/not-a-cid'), null)
})
