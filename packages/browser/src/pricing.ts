import { DEFAULT_ALEPH_API_HOST } from './aleph-api'
import { fetchWithTimeout } from './http'
import type { InstancePricing, PricingState } from './types'

export const DEFAULT_ALEPH_AGGREGATE_ADDRESS = '0xFba561a84A537fCaa567bb7A2257e7142701ae2A'

/**
 * Which pricing entry of the aggregate to read: `instance` for a normal VM,
 * `instance_confidential` for one on AMD SEV / SEV-SNP (twice the compute
 * price on 2026-10-15).
 */
export type InstancePricingKind = 'instance' | 'instance_confidential'

export function parseInstancePricing(payload: unknown, kind: InstancePricingKind = 'instance'): InstancePricing {
  const data = payload as {
    data?: { pricing?: Record<string, unknown> }
    pricing?: Record<string, unknown>
  }
  const pricing = data.data?.pricing ?? data.pricing
  const instance = pricing?.[kind] as InstancePricing | undefined

  if (!instance?.price?.compute_unit || !instance.compute_unit || !Array.isArray(instance.tiers)) {
    throw new Error(`Aleph pricing aggregate does not contain ${kind} pricing.`)
  }

  return instance
}

export async function fetchInstancePricing(
  apiHost = DEFAULT_ALEPH_API_HOST,
  aggregateAddress = DEFAULT_ALEPH_AGGREGATE_ADDRESS,
  kind: InstancePricingKind = 'instance'
): Promise<PricingState> {
  const response = await fetchWithTimeout(`${apiHost}/api/v0/aggregates/${aggregateAddress}.json?keys=pricing`, {
    cache: 'no-cache'
  })

  if (!response.ok) {
    throw new Error(`Pricing aggregate request failed: ${response.status}`)
  }

  const payload = (await response.json()) as { data?: Record<string, unknown> }
  const pricingAggregate = payload.data?.pricing as Record<string, unknown> | undefined

  if (!pricingAggregate) {
    throw new Error('Pricing aggregate response did not include a pricing key.')
  }

  return {
    pricing: parseInstancePricing({ pricing: pricingAggregate }, kind),
    fetchedAt: Date.now()
  }
}
