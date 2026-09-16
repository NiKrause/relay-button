import { promises as dns } from "node:dns"
import { CID } from "multiformats/cid"

export interface DnsLookups {
  resolveCname(name: string): Promise<string[]>
  resolveNs(name: string): Promise<string[]>
  resolve4(name: string): Promise<string[]>
  /** TXT records of `name`, asked from `servers`, or from the system resolver when empty. */
  resolveTxt(name: string, servers: readonly string[]): Promise<string[][]>
}

export const systemDnsLookups: DnsLookups = {
  resolveCname: (name) => dns.resolveCname(name),
  resolveNs: (name) => dns.resolveNs(name),
  resolve4: (name) => dns.resolve4(name),
  async resolveTxt(name, servers) {
    if (servers.length === 0) return dns.resolveTxt(name)
    const resolver = new dns.Resolver()
    resolver.setServers([...servers])
    try {
      return await resolver.resolveTxt(name)
    } catch {
      return dns.resolveTxt(name)
    }
  },
}

function withoutTrailingDot(name: string): string {
  return name.replace(/\.$/u, '')
}

/** IPv4 addresses of the nameservers of the closest enclosing zone that has NS records. */
async function authoritativeServers(name: string, lookups: DnsLookups): Promise<string[]> {
  const labels = name.split('.')
  for (let index = 1; index < labels.length - 1; index += 1) {
    const zone = labels.slice(index).join('.')
    const nameServers = await lookups.resolveNs(zone).catch(() => [] as string[])
    if (nameServers.length === 0) continue
    const addresses = await Promise.all(
      nameServers.map((server) => lookups.resolve4(withoutTrailingDot(server)).catch(() => [] as string[])),
    )
    return [...new Set(addresses.flat())]
  }
  return []
}

/**
 * The DNSLink TXT records of a domain, read from `_dnslink.<domain>` after
 * following its CNAMEs.
 *
 * The TXT record is asked from the nameservers of its own zone, not from a
 * caching resolver: an Aleph domain answers through
 * `_dnslink.<domain>.static.public.aleph.sh`, and a cached answer would hide
 * the update a domain link just made.
 */
export async function resolveDnslink(domain: string, lookups: DnsLookups = systemDnsLookups): Promise<string[]> {
  let name = `_dnslink.${domain}`
  for (let hop = 0; hop < 8; hop += 1) {
    const targets = await lookups.resolveCname(name).catch(() => [] as string[])
    if (targets.length === 0) break
    name = withoutTrailingDot(targets[0]!)
  }
  const servers = await authoritativeServers(name, lookups)
  const records = await lookups.resolveTxt(name, servers)
  return records
    .map((chunks) => chunks.join(''))
    .filter((record) => record.startsWith('dnslink='))
}

/** The CIDv1 a `dnslink=/ipfs/<cid>` record points at, or null. */
export function dnslinkCid(record: string): string | null {
  const match = /^dnslink=\/ipfs\/([^/\s]+)/u.exec(record.trim())
  if (!match) return null
  try {
    return CID.parse(match[1]!).toV1().toString()
  } catch {
    return null
  }
}
