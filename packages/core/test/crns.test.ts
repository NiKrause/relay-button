import test from 'node:test'
import assert from 'node:assert/strict'

import {
  enrichCrnsWithGeo,
  fetchCrns,
  fetchCrnsFromAggregate,
  fetchCrnsWithSource,
  filterDeployableCrns,
  filterReachableCrns,
  listGeocodedCrns,
  mapResourceNodesToCrns,
  probeCrnAvailability,
  rankCandidateCrns,
  selectPreferredCrn
} from '../src/crns.ts'

function jsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload
    }
  }
}

test('fetchCrns reads the active CRN list payload', async () => {
  const result = await fetchCrns({
    url: 'https://crns-list.aleph.sh/crns.json',
    fetch: async (url) => {
      assert.match(String(url), /filter_inactive=true/)
      return jsonResponse({
        crns: [{ hash: 'crn-1', name: 'One' }]
      })
    }
  })

  assert.deepEqual(result, [{ hash: 'crn-1', name: 'One' }])
})

test('enrichCrnsWithGeo preserves already geocoded CRNs and enriches unresolved hosts', async () => {
  const fetchCalls: string[] = []
  const result = await enrichCrnsWithGeo(
    [
      { hash: 'crn-1', address: 'https://alpha.example.com', score: 10 },
      { hash: 'crn-2', address: 'https://beta.example.com', city: 'Berlin', country_code: 'DE' }
    ],
    {
      fetch: async (url) => {
        fetchCalls.push(String(url))
        if (String(url).includes('dns.google/resolve')) {
          return jsonResponse({ Answer: [{ data: '203.0.113.5' }] })
        }
        if (String(url).includes('api.country.is')) {
          return jsonResponse({
            ip: '203.0.113.5',
            city: 'Hamburg',
            subdivision: 'Hamburg',
            country: 'DE'
          })
        }
        throw new Error(`Unexpected URL ${String(url)}`)
      }
    }
  )

  assert.equal(result[0].city, 'Hamburg')
  assert.equal(result[0].country_code, 'DE')
  assert.equal(result[1].city, 'Berlin')
  assert.equal(fetchCalls.filter((entry) => entry.includes('dns.google/resolve')).length, 1)
})

test('listGeocodedCrns returns only compatible geocoded entries', async () => {
  const result = await listGeocodedCrns({
    url: 'https://crns-list.aleph.sh/crns.json',
    limit: 5,
    fetch: async (url) => {
      if (String(url).includes('crns-list.aleph.sh')) {
        return jsonResponse({
          crns: [
            { hash: 'inactive', name: 'Inactive', system_usage: { active: false } },
            { hash: 'nogeo', name: 'NoGeo', address: 'https://nogeo.example.com', score: 5 },
            { hash: 'geoa', name: 'GeoA', address: 'https://a.example.com', score: 10 },
            { hash: 'geob', name: 'GeoB', city: 'Berlin', region: 'Berlin', country: 'Germany', country_code: 'DE', score: 9 }
          ]
        })
      }
      if (String(url).includes('dns.google/resolve') && String(url).includes('a.example.com')) {
        return jsonResponse({ Answer: [{ data: '203.0.113.9' }] })
      }
      if (String(url).includes('dns.google/resolve') && String(url).includes('nogeo.example.com')) {
        return jsonResponse({}, 404)
      }
      if (String(url).includes('api.country.is')) {
        return jsonResponse({
          ip: '203.0.113.9',
          city: 'Aachen',
          subdivision: 'North Rhine-Westphalia',
          country: 'DE'
        })
      }
      throw new Error(`Unexpected URL ${String(url)}`)
    }
  })

  assert.deepEqual(
    result.map((entry) => entry.hash),
    ['geob', 'geoa']
  )
})

test('filterDeployableCrns keeps only active qemu-capable CRNs with enough capacity and sorts by score', () => {
  const result = filterDeployableCrns(
    [
      { hash: 'inactive', name: 'Inactive', score: 99, system_usage: { active: false } },
      { hash: 'no-qemu', name: 'No QEMU', score: 95, qemu_support: false },
      {
        hash: 'too-small',
        name: 'Too Small',
        score: 90,
        system_usage: {
          active: true,
          cpu: { count: 1 },
          mem: { available_kB: 1024 },
          disk: { available_kB: 1024 }
        }
      },
      {
        hash: 'fit-high',
        name: 'Fit High',
        score: 92.1,
        system_usage: {
          active: true,
          cpu: { count: 4 },
          mem: { available_kB: 16 * 1024 * 1024 },
          disk: { available_kB: 200 * 1024 * 1024 }
        }
      },
      {
        hash: 'fit-low',
        name: 'Fit Low',
        score: 71.5,
        system_usage: {
          active: true,
          cpu: { count: 2 },
          mem: { available_kB: 8 * 1024 * 1024 },
          disk: { available_kB: 100 * 1024 * 1024 }
        }
      }
    ],
    {
      spec: {
        vcpus: 2,
        memoryMiB: 2048,
        diskMiB: 20480
      }
    }
  )

  assert.deepEqual(result.map((entry) => entry.name), ['Fit High', 'Fit Low'])
})

test('rankCandidateCrns prioritizes the preferred country while preserving score order otherwise', async () => {
  const ranked = await rankCandidateCrns(
    [
      { hash: 'us-best', name: 'US Best', country_code: 'US', score: 100 },
      { hash: 'de-mid', name: 'DE Mid', address: 'https://de.example.com', score: 90 },
      { hash: 'us-low', name: 'US Low', country_code: 'US', score: 80 }
    ],
    {
      preferredCountryCode: 'DE',
      geoLimit: 2,
      fetch: async (url) => {
        if (String(url).includes('dns.google/resolve')) {
          return jsonResponse({ Answer: [{ data: '198.51.100.8' }] })
        }
        if (String(url).includes('api.country.is')) {
          return jsonResponse({
            ip: '198.51.100.8',
            city: 'Berlin',
            subdivision: 'Berlin',
            country: 'DE'
          })
        }
        throw new Error(`Unexpected URL ${String(url)}`)
      }
    }
  )

  assert.deepEqual(ranked.map((entry) => entry.hash), ['de-mid', 'us-best', 'us-low'])
})

test('selectPreferredCrn returns the best ranked CRN or null', async () => {
  const selected = await selectPreferredCrn(
    [
      { hash: 'crn-1', country_code: 'US', score: 5 },
      { hash: 'crn-2', country_code: 'DE', score: 4 }
    ],
    {
      preferredCountryCode: 'DE',
      fetch: async () => jsonResponse({})
    }
  )

  assert.equal(selected?.hash, 'crn-2')
  assert.equal(
    await selectPreferredCrn([], {
      preferredCountryCode: 'DE',
      fetch: async () => jsonResponse({})
    }),
    null
  )
})

function corechannelPayload(resourceNodes: unknown[]) {
  return {
    address: '0xa1B3bb7d2332383D96b7796B908fB7f7F3c2Be10',
    data: {
      corechannel: {
        resource_nodes: resourceNodes
      }
    }
  }
}

test('mapResourceNodesToCrns keeps linked compute nodes and drops the rest', () => {
  const result = mapResourceNodesToCrns([
    {
      hash: 'crn-linked',
      name: 'Linked',
      address: 'https://linked.example.com/',
      score: 0.91,
      status: 'linked',
      type: 'compute',
      parent: 'ccn-1',
      inactive_since: null
    },
    { hash: 'crn-waiting', address: 'https://waiting.example.com', status: 'waiting', parent: 'ccn-1' },
    { hash: 'crn-orphan', address: 'https://orphan.example.com', status: 'linked', parent: null },
    { hash: 'crn-inactive', address: 'https://old.example.com', status: 'linked', parent: 'ccn-1', inactive_since: 1730000000 },
    { hash: 'crn-locked', address: 'https://locked.example.com', status: 'linked', parent: 'ccn-1', locked: true },
    { hash: 'crn-no-address', status: 'linked', parent: 'ccn-1' },
    { hash: 'crn-scorev1', address: 'bare.example.com', status: 'linked', parent: 'ccn-1', score: null, scoreV1: 0.8 }
  ])

  assert.deepEqual(
    result.map((crn) => crn.hash),
    ['crn-linked', 'crn-scorev1']
  )
  assert.equal(result[0].address, 'https://linked.example.com')
  assert.equal(result[0].score, 0.91)
  // A schemeless registry address still has to become a usable base URL.
  assert.equal(result[1].address, 'https://bare.example.com')
  assert.equal(result[1].score, 0.8)
  // The aggregate cannot report these, so they must stay absent rather than
  // become a false negative in filterDeployableCrns.
  assert.equal(result[0].qemu_support, undefined)
  assert.equal(result[0].system_usage, undefined)
})

test('fetchCrnsFromAggregate walks the API hosts until one answers', async () => {
  const requested: string[] = []
  const result = await fetchCrnsFromAggregate({
    apiHosts: ['https://api-down.example.com', 'https://api-up.example.com'],
    fetch: async (url) => {
      requested.push(String(url))
      if (String(url).includes('api-down')) return jsonResponse({}, 500)
      return jsonResponse(
        corechannelPayload([
          { hash: 'crn-1', address: 'https://one.example.com', status: 'linked', parent: 'ccn-1', score: 0.9 }
        ])
      )
    }
  })

  assert.deepEqual(result.map((crn) => crn.hash), ['crn-1'])
  assert.equal(requested.length, 2)
  assert.match(requested[1], /\/api\/v0\/aggregates\/0xa1B3bb7d2332383D96b7796B908fB7f7F3c2Be10\.json\?keys=corechannel$/)
})

test('fetchCrnsWithSource falls back to the aggregate when the CRN list is down', async () => {
  const diagnostics: string[] = []
  const result = await fetchCrnsWithSource({
    url: 'https://crns-list.aleph.sh/crns.json',
    onDiagnostic: (message) => diagnostics.push(message),
    fetch: async (url) => {
      if (String(url).includes('crns-list')) return jsonResponse('<html>502</html>', 502)
      return jsonResponse(
        corechannelPayload([
          { hash: 'crn-1', address: 'https://one.example.com', status: 'linked', parent: 'ccn-1', score: 0.9 }
        ])
      )
    }
  })

  assert.equal(result.source, 'aggregate')
  assert.deepEqual(result.crns.map((crn) => crn.hash), ['crn-1'])
  assert.match(result.listError?.message ?? '', /502/)
  assert.equal(diagnostics.length, 1)
  assert.match(diagnostics[0], /corechannel aggregate/)
})

test('fetchCrnsWithSource falls back when the CRN list connection fails outright', async () => {
  const result = await fetchCrnsWithSource({
    fetch: async (url) => {
      if (String(url).includes('crns-list')) throw new TypeError('Failed to fetch')
      return jsonResponse(
        corechannelPayload([
          { hash: 'crn-1', address: 'https://one.example.com', status: 'linked', parent: 'ccn-1' }
        ])
      )
    }
  })

  assert.equal(result.source, 'aggregate')
  assert.equal(result.crns.length, 1)
})

test('fetchCrnsWithSource prefers the polled list when it is healthy', async () => {
  const requested: string[] = []
  const result = await fetchCrnsWithSource({
    fetch: async (url) => {
      requested.push(String(url))
      return jsonResponse({ crns: [{ hash: 'crn-live', qemu_support: true }] })
    }
  })

  assert.equal(result.source, 'list')
  assert.deepEqual(result.crns, [{ hash: 'crn-live', qemu_support: true }])
  assert.equal(requested.length, 1)
})

test('fetchCrnsWithSource reports both failures when the aggregate is unusable too', async () => {
  await assert.rejects(
    fetchCrnsWithSource({
      fetch: async () => jsonResponse({}, 502)
    }),
    /CRN list request failed: 502; CRN aggregate fallback failed: CRN aggregate request failed: 502/
  )
})

test('fetchCrnsWithSource can read the aggregate directly', async () => {
  const requested: string[] = []
  const result = await fetchCrnsWithSource({
    preferAggregate: true,
    fetch: async (url) => {
      requested.push(String(url))
      return jsonResponse(
        corechannelPayload([
          { hash: 'crn-1', address: 'https://one.example.com', status: 'linked', parent: 'ccn-1' }
        ])
      )
    }
  })

  assert.equal(result.source, 'aggregate')
  assert.ok(requested.every((url) => !url.includes('crns-list')))
})

test('probeCrnAvailability accepts v1 nodes and rejects dead ones', async () => {
  const probedPaths: string[] = []
  const v1Only = await probeCrnAvailability(
    { hash: 'crn-1', address: 'https://one.example.com/' },
    {
      fetch: async (url) => {
        probedPaths.push(new URL(String(url)).pathname)
        return jsonResponse({}, String(url).includes('/v2/') ? 404 : 200)
      }
    }
  )

  assert.equal(v1Only, true)
  assert.deepEqual(probedPaths, ['/v2/about/executions/list', '/about/executions/list'])

  assert.equal(
    await probeCrnAvailability(
      { hash: 'crn-2', address: 'https://two.example.com' },
      { fetch: async () => jsonResponse({}, 502) }
    ),
    false
  )
  assert.equal(
    await probeCrnAvailability(
      { hash: 'crn-3', address: 'https://three.example.com' },
      {
        fetch: async () => {
          throw new Error('ECONNREFUSED')
        }
      }
    ),
    false
  )
  assert.equal(
    await probeCrnAvailability({ hash: 'crn-4' }, { fetch: async () => jsonResponse({}) }),
    false
  )
})

test('filterReachableCrns drops unreachable head entries but keeps the unprobed tail', async () => {
  const diagnostics: string[] = []
  const result = await filterReachableCrns(
    [
      { hash: 'crn-dead', address: 'https://dead.example.com' },
      { hash: 'crn-live', address: 'https://live.example.com' },
      { hash: 'crn-tail', address: 'https://tail.example.com' }
    ],
    {
      limit: 2,
      onDiagnostic: (message) => diagnostics.push(message),
      fetch: async (url) => (String(url).includes('dead') ? jsonResponse({}, 503) : jsonResponse({}))
    }
  )

  assert.deepEqual(result.map((crn) => crn.hash), ['crn-live', 'crn-tail'])
  assert.match(diagnostics[0], /Skipping 1 unreachable CRN of 2 probed/)
})

test('filterReachableCrns keeps the ranking when no CRN is reachable at all', async () => {
  const diagnostics: string[] = []
  const crns = [
    { hash: 'crn-1', address: 'https://one.example.com' },
    { hash: 'crn-2', address: 'https://two.example.com' }
  ]

  const result = await filterReachableCrns(crns, {
    onDiagnostic: (message) => diagnostics.push(message),
    fetch: async () => {
      throw new Error('network unreachable from this runner')
    }
  })

  assert.deepEqual(result.map((crn) => crn.hash), ['crn-1', 'crn-2'])
  assert.match(diagnostics[0], /keeping the unverified ranking/)
})
