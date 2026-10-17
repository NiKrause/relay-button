// Nodes AMD cannot vouch for: KDS has no VCEK for their chip, so no guest on
// them can ever be attested. Each such attempt costs a deploy, a wallet
// signature and about a minute before the failover, so a node that answered
// that way is tried last on the next confidential start. Demoted, not
// dropped: if every node is affected, the start still tries them.
//
// Kept in memory for the page; persisted only under a key the site names
// (`confidentialStart.refusedNodesStorageKey`), as the widget writes nothing
// to storage unasked.

const TTL_MS = 7 * 24 * 60 * 60 * 1000
const remembered = new Map<string, number>()

/** The verdict that means "AMD has no certificate for this chip". */
export function isUnverifiableNodeError(message: string): boolean {
  return /AMD KDS answered 404/i.test(message)
}

function load(storageKey: string | undefined, now: number): void {
  if (!storageKey) return
  try {
    const stored = JSON.parse(globalThis.localStorage?.getItem(storageKey) ?? '{}') as Record<string, unknown>
    for (const [hash, until] of Object.entries(stored)) {
      if (/^[0-9a-f]{64}$/.test(hash) && typeof until === 'number' && until > now) {
        remembered.set(hash, Math.max(until, remembered.get(hash) ?? 0))
      }
    }
  } catch {
    // Storage blocked or malformed: memory only.
  }
}

/** Hashes of nodes refused within the last week. */
export function unverifiableCrnHashes(storageKey?: string, now = Date.now()): Set<string> {
  load(storageKey, now)
  for (const [hash, until] of remembered) if (until <= now) remembered.delete(hash)
  return new Set(remembered.keys())
}

export function rememberUnverifiableCrn(hash: string, storageKey?: string, now = Date.now()): void {
  if (!/^[0-9a-f]{64}$/.test(hash)) return
  load(storageKey, now)
  remembered.set(hash, now + TTL_MS)
  if (!storageKey) return
  try {
    globalThis.localStorage?.setItem(storageKey, JSON.stringify(Object.fromEntries(remembered)))
  } catch {
    // Storage blocked: memory only.
  }
}

/** `crns` with the remembered nodes moved to the end, except one the person pinned. */
export function demoteUnverifiableCrns<T extends { hash: string }>(crns: T[], refused: Set<string>, pinned: string | null): T[] {
  const demoted = (crn: T) => refused.has(crn.hash) && crn.hash !== pinned
  return [...crns.filter((crn) => !demoted(crn)), ...crns.filter(demoted)]
}

/** Tests only. */
export function forgetUnverifiableCrns(): void {
  remembered.clear()
}
