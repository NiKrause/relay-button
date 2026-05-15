import test from 'node:test'
import assert from 'node:assert/strict'

import { retainSuccessfulDeployments } from '../src/retention.ts'

function jsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload
    }
  }
}

test('retainSuccessfulDeployments keeps latest records, publishes aggregate, and forgets pruned hashes', async () => {
  const writes: Array<{ url: string; body: string }> = []

  const result = await retainSuccessfulDeployments({
    sender: '0x1234',
    keepCount: 1,
    currentRecord: {
      instance_item_hash: 'instance-new',
      rootfs_item_hash: 'rootfs-new',
      site_item_hash: 'site-new',
      deployed_at: '2026-05-15T00:00:00Z'
    },
    extraForgetHashes: ['extra-hash'],
    signer: async () => '0xsigned',
    hasher: (() => {
      let count = 0
      return async () => `hash-${++count}`
    })(),
    fetch: async (url, init) => {
      if (String(url).includes('/api/v0/aggregates/0x1234.json')) {
        return jsonResponse({
          data: {
            'uc-go-peer-successful-deployments': {
              deployments: [
                {
                  instance_item_hash: 'instance-old',
                  rootfs_item_hash: 'rootfs-old',
                  site_item_hash: 'site-old',
                  deployed_at: '2026-05-14T00:00:00Z'
                }
              ]
            }
          }
        })
      }

      writes.push({
        url: String(url),
        body: String(init?.body ?? '')
      })
      return jsonResponse({ message_status: 'processed' })
    }
  })

  assert.equal(result.retainedRecords.length, 1)
  assert.equal(result.retainedRecords[0].instance_item_hash, 'instance-new')
  assert.deepEqual(result.forgetHashes.sort(), ['extra-hash', 'instance-old', 'rootfs-old', 'site-old'].sort())
  assert.equal(result.aggregatePublication.status, 'processed')
  assert.equal(result.forgetResult?.status, 'processed')
  assert.equal(writes.length, 2)
})
