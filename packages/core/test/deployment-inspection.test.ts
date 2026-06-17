import test from 'node:test'
import assert from 'node:assert/strict'

import {
  fetchMessageEnvelope,
  isTransientMessageLookupError,
  inspectDeploymentResult,
  inspectMessageResult,
  waitForDeploymentResult
} from '../src/deployment-inspection.ts'

test('fetchMessageEnvelope returns null for 404 responses', async () => {
  const result = await fetchMessageEnvelope('hash', {
    fetch: async () => ({
      ok: false,
      status: 404,
      async json() {
        return {}
      }
    })
  })

  assert.equal(result, null)
})

test('inspectMessageResult reports missing messages clearly', async () => {
  const result = await inspectMessageResult('missingHash', {
    fetch: async () => ({
      ok: false,
      status: 404,
      async json() {
        return {}
      }
    }),
    label: 'Deployment message'
  })

  assert.equal(result.status, 'unknown')
  assert.match(result.rejectionReason ?? '', /missingHash was not found/)
})

test('inspectMessageResult explains rejected balance errors', async () => {
  const result = await inspectMessageResult('hash', {
    fetch: async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          status: 'rejected',
          error_code: 6,
          details: {
            errors: [
              {
                account_balance: 1,
                required_balance: 3
              }
            ]
          }
        }
      }
    })
  })

  assert.equal(result.status, 'rejected')
  assert.match(result.rejectionReason ?? '', /insufficient Aleph balance/i)
  assert.match(result.rejectionReason ?? '', /2\.000 short/i)
})

test('isTransientMessageLookupError detects retryable Aleph message lookup failures', () => {
  assert.equal(isTransientMessageLookupError(new Error('Message lookup failed: 503')), true)
  assert.equal(isTransientMessageLookupError(new Error('Message lookup failed: 429')), true)
  assert.equal(isTransientMessageLookupError(new Error('Message lookup failed: 404')), false)
  assert.equal(isTransientMessageLookupError(new Error('Something else failed')), false)
})

test('inspectDeploymentResult loads related references and explains rejected rootfs dependencies', async () => {
  const calls: string[] = []
  const result = await inspectDeploymentResult('deployHash', {
    rootfsRef: 'rootfsHash',
    fetch: async (url) => {
      calls.push(url)
      if (url.endsWith('/deployHash')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              status: 'rejected',
              error_code: 5,
              details: {
                errors: ['rootfsHash']
              }
            }
          }
        }
      }
      if (url.endsWith('/rootfsHash')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              status: 'pending',
              type: 'STORE'
            }
          }
        }
      }
      throw new Error(`Unexpected URL ${url}`)
    }
  })

  assert.equal(result.status, 'rejected')
  assert.equal(result.references.length, 1)
  assert.deepEqual(result.references[0], {
    itemHash: 'rootfsHash',
    status: 'pending',
    type: 'STORE'
  })
  assert.match(result.rejectionReason ?? '', /rootfs STORE message rootfsHash is still pending/i)
  assert.equal(calls.length, 2)
})

test('waitForDeploymentResult polls until a deployment is processed', async () => {
  let callCount = 0
  const sleeps: number[] = []

  const result = await waitForDeploymentResult('deployHash', {
    attempts: 3,
    delayMs: 25,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    fetch: async () => {
      callCount += 1
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            status: callCount >= 2 ? 'processed' : 'pending',
            type: 'INSTANCE'
          }
        }
      }
    }
  })

  assert.equal(result.status, 'processed')
  assert.equal(callCount, 2)
  assert.deepEqual(sleeps, [25])
})
