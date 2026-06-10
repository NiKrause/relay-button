import test from 'node:test'
import assert from 'node:assert/strict'

import {
  fetchVmBootstrapConfigSignals,
  waitForVmBootstrapConfigSignal,
} from '../src/bootstrap-config.ts'

test('fetchVmBootstrapConfigSignals filters matching status posts', async () => {
  const signals = await fetchVmBootstrapConfigSignals({
    deploymentToken: 'deploy-123',
    ownerAddress: '0xOwner',
    instanceItemHash: 'instance-hash',
    fetch: async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          posts: [
            {
              content: {
                deploymentToken: 'deploy-123',
                status: 'applied',
                profile: 'uc-go-peer',
                ownerAddress: '0xowner',
                instanceItemHash: 'instance-hash',
                updatedAt: '2026-06-09T12:00:00Z',
                publisherAddress: '0xpublisher',
              },
            },
            {
              content: {
                deploymentToken: 'other',
                status: 'applied',
                profile: 'uc-go-peer',
                ownerAddress: '0xowner',
                instanceItemHash: 'instance-hash',
                updatedAt: '2026-06-09T12:00:00Z',
              },
            },
          ],
        }
      },
    }),
  })

  assert.equal(signals.length, 1)
  assert.equal(signals[0]?.deploymentToken, 'deploy-123')
  assert.equal(signals[0]?.publisherAddress, '0xpublisher')
})

test('waitForVmBootstrapConfigSignal resolves once the applied signal appears', async () => {
  let attempts = 0

  const signal = await waitForVmBootstrapConfigSignal({
    deploymentToken: 'deploy-123',
    ownerAddress: '0xowner',
    instanceItemHash: 'instance-hash',
    attempts: 3,
    delayMs: 0,
    sleep: async () => undefined,
    fetch: async () => {
      attempts += 1
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            posts:
              attempts < 2
                ? []
                : [
                    {
                      item_content: JSON.stringify({
                        type: 'vm-bootstrap-config-status',
                        address: '0xpublisher',
                        ref: 'vm-bootstrap-config',
                        content: {
                          deploymentToken: 'deploy-123',
                          status: 'applied',
                          profile: 'uc-go-peer',
                          ownerAddress: '0xowner',
                          instanceItemHash: 'instance-hash',
                          updatedAt: '2026-06-09T12:00:00Z',
                        },
                      }),
                    },
                  ],
          }
        },
      }
    },
  })

  assert.equal(attempts, 2)
  assert.equal(signal?.status, 'applied')
  assert.equal(signal?.deploymentToken, 'deploy-123')
})
