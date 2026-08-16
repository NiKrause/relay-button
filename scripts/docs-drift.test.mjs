import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'

// Documentation drifts silently: nothing fails when a prop is added and its
// table is not, so the gap is only found by a reader who trusted the page. Each
// check below corresponds to a finding from the docs audit that these tests
// would have caught on the commit that introduced it.

const repo = fileURLToPath(new URL('..', import.meta.url))
const read = (path) => readFileSync(join(repo, path), 'utf8')

const DOCS = join(repo, 'docs/docusaurus/docs')

function docPages(dir = DOCS) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return docPages(full)
    return entry.endsWith('.md') ? [full] : []
  })
}

test('every SponsorRelayProps prop is documented in the UI reference', () => {
  const source = read('packages/ui/src/shared/types.ts')
  const block = source.match(/export interface SponsorRelayProps \{([\s\S]*?)\n\}/)
  assert.ok(block, 'SponsorRelayProps not found — has the interface been renamed?')

  const props = [...block[1].matchAll(/^ {2}([a-zA-Z]+)\??:/gm)].map((m) => m[1])
  assert.ok(props.length > 5, `only ${props.length} props parsed; the regex has probably stopped matching`)

  // Word-boundary, not substring: `apiHost` and `apiHosts` are both props, and
  // a plain `includes` would count the shorter one as documented whenever the
  // longer one appears.
  const page = read('docs/docusaurus/docs/reference/ui.md')
  const missing = props.filter((prop) => !new RegExp(`\\b${prop}\\b`).test(page))

  assert.deepEqual(
    missing,
    [],
    `undocumented in reference/ui.md: ${missing.join(', ')}. ` +
      'Add them to the Props table — that table is what consumers and the agent recipes are pointed at.',
  )
})

test('every HTTP path a profile routes is named in the rootfs contract', () => {
  // The guest's HTTP surface is a contract with consumers, and the deployment
  // card reads it live. A profile that starts serving a path nobody documents
  // is a path nobody can rely on.
  const profiles = [
    'packages/rootfs/reference/uc-go-peer/rootfs/uc-go-peer-configure.sh',
    'packages/rootfs/reference/orbitdb-relay/rootfs/orbitdb-relay-configure.sh',
  ]

  const routed = new Set()
  for (const profile of profiles) {
    for (const match of read(profile).matchAll(/^\s*handle(?:_path)?\s+(\/[a-z*/-]+)\s*\{/gm)) {
      // Wildcards are route families, not documented endpoints on their own.
      if (!match[1].includes('*')) routed.add(match[1])
    }
  }
  assert.ok(routed.size > 0, 'no routed paths parsed; has the Caddyfile template changed shape?')

  const contract = read('docs/docusaurus/docs/reference/rootfs-contract.md')
  const missing = [...routed].filter((path) => !contract.includes(path))

  assert.deepEqual(
    missing,
    [],
    `routed but undocumented: ${missing.join(', ')}. ` +
      'Add them to the Runtime HTTP Surface section of reference/rootfs-contract.md.',
  )
})

test('the quick start does not tell readers to install the latest dist-tag blindly', () => {
  // `latest` trails `next` by design: releases are promoted only after consumer
  // testing. A bare install therefore hands over a build that predates the
  // features the rest of the docs describe.
  const page = read('docs/docusaurus/docs/getting-started.md')

  const bare = [...page.matchAll(/npm install (@le-space\/[a-z-]+)\s*$/gm)].map((m) => m[1])
  assert.deepEqual(
    bare,
    [],
    `unpinned install of ${bare.join(', ')}. Use @next or an explicit version — ` +
      'a bare install resolves to `latest`, which is deliberately behind.',
  )

  assert.match(
    page,
    /dist-tag/,
    'the quick start installs from a tag but never explains that two exist',
  )
})

test('no docs page reads as a plan rather than a description', () => {
  // Proposals live in the issue tracker. A reader cannot tell a plan from a
  // fact once both render as a docs page, and a stale plan discredits the pages
  // around it.
  const PLAN_HEADINGS =
    /^#{2,3} (Remaining Requirements|Next Implementation Focus|Implementation Plan|Suggested Next Steps|Current Versus Target|Step-By-Step Plan|Research Update)/gm

  const offenders = docPages()
    .flatMap((file) => {
      const headings = [...readFileSync(file, 'utf8').matchAll(PLAN_HEADINGS)].map((m) => m[1])
      return headings.map((heading) => `${relative(repo, file)} → "${heading}"`)
    })

  assert.deepEqual(
    offenders,
    [],
    `plan-shaped sections found:\n  ${offenders.join('\n  ')}\n` +
      'Move the intent to an issue and leave the page describing what is true today.',
  )
})
