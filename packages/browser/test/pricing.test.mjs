import assert from 'node:assert/strict'
import test from 'node:test'

import { fetchInstancePricing, parseInstancePricing } from '../dist/index.js'

test('parseInstancePricing reads instance pricing from aggregate payloads', () => {
  const pricing = parseInstancePricing({
    pricing: {
      instance: {
        price: {
          compute_unit: { holding: '1.23' }
        },
        compute_unit: {
          vcpus: 1,
          memory_mib: 2048,
          disk_mib: 10240
        },
        tiers: [{ id: 'micro', compute_units: 1 }]
      }
    }
  })

  assert.equal(pricing.compute_unit.vcpus, 1)
  assert.equal(pricing.tiers[0].id, 'micro')
})

test('fetchInstancePricing requests the pricing aggregate and returns pricing state', async () => {
  const originalFetch = globalThis.fetch
  const originalNow = Date.now

  try {
    let capturedUrl = ''
    Date.now = () => 123456789
    globalThis.fetch = async (input) => {
      capturedUrl = String(input)
      return new Response(
        JSON.stringify({
          data: {
            pricing: {
              instance: {
                price: {
                  compute_unit: { holding: '1.23' }
                },
                compute_unit: {
                  vcpus: 1,
                  memory_mib: 2048,
                  disk_mib: 10240
                },
                tiers: [{ id: 'micro', compute_units: 1 }]
              }
            }
          }
        }),
        { status: 200 }
      )
    }

    const result = await fetchInstancePricing()
    assert.match(capturedUrl, /\/api\/v0\/aggregates\/0xFba561a84A537fCaa567bb7A2257e7142701ae2A\.json\?keys=pricing/)
    assert.equal(result.fetchedAt, 123456789)
    assert.equal(result.pricing?.tiers[0].id, 'micro')
  } finally {
    globalThis.fetch = originalFetch
    Date.now = originalNow
  }
})
