import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { buildForget, parseEnv, signaturePayload } from '../reference/github-runner/rootfs/forget-self.mjs'

const owner = '0x' + '11'.repeat(20)
const sender = '0x' + '22'.repeat(20)
const instance = 'ab'.repeat(32)

test('forget-self speaks for the owner and names only its own INSTANCE', () => {
  const message = buildForget({ sender, owner, instance, reason: 'done', now: 1 })
  const content = JSON.parse(message.item_content)
  assert.equal(message.sender, sender)
  assert.equal(content.address, owner)
  assert.deepEqual(content.hashes, [instance])
  assert.deepEqual(content.aggregates, [])
  assert.equal(message.item_hash, createHash('sha256').update(message.item_content).digest('hex'))
  assert.equal(signaturePayload(message), `ETH\n${sender}\nFORGET\n${message.item_hash}`)
})

test('forget-self refuses anything but one item hash and an owner address', () => {
  assert.throws(() => buildForget({ sender, owner, instance: 'nope', reason: 'x' }), /64-hex/)
  assert.throws(() => buildForget({ sender, owner: 'nope', instance, reason: 'x' }), /0x address/)
})

test('forget-self reads a plain env file', () => {
  assert.deepEqual(parseEnv('A=1\nB="two"\n# c\nlower=x\n'), { A: '1', B: 'two' })
})
