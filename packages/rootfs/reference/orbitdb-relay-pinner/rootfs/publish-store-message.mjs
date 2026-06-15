#!/usr/bin/env node

import { createHash } from 'node:crypto'

const [{ Wallet }] = await Promise.all([
  import('ethers'),
])

function requiredEnv(name) {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`)
  }
  return value
}

function normalizeApiHost(value) {
  return value.replace(/\/+$/u, '')
}

const cid = process.argv[2]?.trim()
if (!cid) {
  throw new Error('Usage: publish-store-message.mjs <cid>')
}

const wallet = new Wallet(requiredEnv('ALEPH_PRIVATE_KEY'))
const apiHost = normalizeApiHost(process.env.ALEPH_API_HOST?.trim() || 'https://api2.aleph.im')
const channel = process.env.CHANNEL?.trim() || 'ALEPH-CLOUDSOLUTIONS'
const ref = process.env.ALEPH_ROOTFS_REF?.trim() || undefined
const time = Date.now() / 1000

const content = {
  address: wallet.address,
  time,
  item_type: 'ipfs',
  item_hash: cid,
  ...(ref ? { ref } : {}),
}
const itemContent = JSON.stringify(content)
const itemHash = createHash('sha256').update(itemContent).digest('hex')
const message = {
  sender: wallet.address,
  chain: 'ETH',
  type: 'STORE',
  item_hash: itemHash,
  item_type: 'inline',
  item_content: itemContent,
  time,
  channel,
}
const signaturePayload = [message.chain, message.sender, message.type, message.item_hash].join('\n')
const signature = await wallet.signMessage(signaturePayload)

const response = await fetch(`${apiHost}/api/v0/messages`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
  },
  body: JSON.stringify({
    sync: true,
    message: {
      ...message,
      signature,
    },
  }),
})

const payload = await response.json().catch(() => ({}))
process.stdout.write(`${JSON.stringify(payload)}\n`)

if (!response.ok) {
  process.exit(1)
}
