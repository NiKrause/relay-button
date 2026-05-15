import test from 'node:test'
import assert from 'node:assert/strict'

import {
  broadcastAlephMessage,
  isInvalidMessageFormatResponse,
  isRetryableBroadcastFailure,
  normalizeBroadcastStatus,
  postBroadcastPayload,
  signAlephMessage,
  signaturePayload
} from '../src/broadcast.ts'

const unsignedMessage = {
  sender: '0xabc',
  chain: 'ETH' as const,
  type: 'INSTANCE' as const,
  item_hash: 'deadbeef',
  item_type: 'inline' as const,
  item_content: '{"ok":true}',
  time: 123,
  channel: 'TEST'
}

test('signaturePayload uses the expected line-separated format', () => {
  assert.equal(signaturePayload(unsignedMessage), 'ETH\n0xabc\nINSTANCE\ndeadbeef')
})

test('signAlephMessage normalizes missing 0x prefix from the signer', async () => {
  const signed = await signAlephMessage(unsignedMessage, async () => 'abcd1234')
  assert.equal(signed.signature, '0xabcd1234')
})

test('normalizeBroadcastStatus treats 202 as pending', () => {
  assert.equal(normalizeBroadcastStatus(202, undefined), 'pending')
  assert.equal(normalizeBroadcastStatus(200, 'processed'), 'processed')
})

test('invalid message format detection matches Aleph 422 responses', () => {
  assert.equal(
    isInvalidMessageFormatResponse(
      { status: 422 },
      { details: { message: 'InvalidMessageFormat: wrong shape' } }
    ),
    true
  )
})

test('retryable broadcast failure detects publication error payloads', () => {
  assert.equal(
    isRetryableBroadcastFailure(
      { status: 400 },
      { publication_status: { status: 'error' } }
    ),
    true
  )
})

test('postBroadcastPayload posts json to Aleph messages endpoint', async () => {
  let seenBody = ''
  const result = await postBroadcastPayload(
    { ok: true },
    {
      fetch: async (url, init) => {
        assert.match(url, /api\/v0\/messages$/)
        seenBody = String(init?.body ?? '')
        return {
          ok: true,
          status: 200,
          async json() {
            return { message_status: 'processed' }
          }
        }
      }
    }
  )

  assert.equal(seenBody, JSON.stringify({ ok: true }))
  assert.equal(result.httpStatus, 200)
  assert.equal(result.response.message_status, 'processed')
})

test('broadcastAlephMessage retries request-shape compatibility fallbacks', async () => {
  let attempt = 0
  const result = await broadcastAlephMessage(
    {
      ...unsignedMessage,
      signature: '0x1234'
    },
    {
      fetch: async () => {
        attempt += 1
        if (attempt === 1) {
          return {
            ok: false,
            status: 422,
            async json() {
              return { details: { message: 'InvalidMessageFormat: nested body not accepted' } }
            }
          }
        }

        return {
          ok: true,
          status: 200,
          async json() {
            return { message_status: 'processed' }
          }
        }
      }
    }
  )

  assert.equal(attempt, 2)
  assert.equal(result.httpStatus, 200)
  assert.equal(result.response.message_status, 'processed')
})

test('broadcastAlephMessage throws when failure is not retryable', async () => {
  await assert.rejects(
    () =>
      broadcastAlephMessage(
        {
          ...unsignedMessage,
          signature: '0x1234'
        },
        {
          fetch: async () => ({
            ok: false,
            status: 400,
            async json() {
              return { details: 'fatal error' }
            }
          })
        }
      ),
    /Broadcast failed: 400/
  )
})
