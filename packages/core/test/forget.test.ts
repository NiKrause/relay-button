import test from 'node:test'
import assert from 'node:assert/strict'

import { cleanupFailedDeployment, createUnsignedForgetMessage, forgetAlephMessages } from '../src/forget.ts'

function jsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload
    }
  }
}

test('createUnsignedForgetMessage requires at least one hash or aggregate and hashes the payload', async () => {
  await assert.rejects(
    () =>
      createUnsignedForgetMessage({
        sender: '0x1234',
        hasher: async () => 'hash-1'
      }),
    /FORGET message requires/
  )

  const message = await createUnsignedForgetMessage({
    sender: '0x1234',
    hashes: ['instance-1'],
    reason: 'cleanup',
    hasher: async () => 'hash-1'
  })

  assert.equal(message.type, 'FORGET')
  assert.equal(message.item_hash, 'hash-1')
})

test('forgetAlephMessages signs and broadcasts a forget message', async () => {
  const result = await forgetAlephMessages({
    sender: '0x1234',
    hashes: ['instance-1'],
    signer: async () => '0xsigned',
    hasher: async () => 'hash-1',
    fetch: async (url, init) => {
      assert.match(String(url), /\/api\/v0\/messages$/)
      assert.equal(init?.method, 'POST')
      return jsonResponse({ message_status: 'processed' })
    }
  })

  assert.equal(result.itemHash, 'hash-1')
  assert.equal(result.status, 'processed')
})

test('cleanupFailedDeployment swallows forget errors into an error payload', async () => {
  const result = await cleanupFailedDeployment({
    sender: '0x1234',
    instanceItemHash: 'instance-1',
    signer: async () => '0xsigned',
    hasher: async () => 'hash-1',
    fetch: async () => {
      throw new Error('network failed')
    }
  })

  assert.deepEqual(result, { error: 'network failed' })
})
