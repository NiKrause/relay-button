#!/usr/bin/env node
// Sends FORGET for this VM's own INSTANCE on behalf of the wallet that pays
// for it. The key is a delegate the owner authorized for FORGET only; Aleph
// accepts a message whose content.address is the owner when its sender holds
// such an authorization. Usage: forget-self.mjs <env-file> [reason]
//
// env file: ALEPH_FORGET_KEY, ALEPH_OWNER, ALEPH_INSTANCE, optional ALEPH_API_HOST
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

export function parseEnv(text) {
  const env = {}
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)=(.*)$/u.exec(line)
    if (match) env[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/u, '$2')
  }
  return env
}

export function buildForget({ sender, owner, instance, reason, now = Date.now() / 1000 }) {
  if (!/^[a-f0-9]{64}$/u.test(instance)) throw new Error('ALEPH_INSTANCE must be a 64-hex item hash')
  if (!/^0x[0-9a-fA-F]{40}$/u.test(owner)) throw new Error('ALEPH_OWNER must be an 0x address')
  const itemContent = JSON.stringify({
    address: owner,
    time: now,
    hashes: [instance],
    aggregates: [],
    reason
  })
  return {
    sender,
    chain: 'ETH',
    type: 'FORGET',
    item_hash: createHash('sha256').update(itemContent).digest('hex'),
    item_type: 'inline',
    item_content: itemContent,
    time: now,
    channel: 'ALEPH-CLOUDSOLUTIONS'
  }
}

export function signaturePayload(message) {
  return [message.chain, message.sender, message.type, message.item_hash].join('\n')
}

async function main() {
  const [envFile, reason = 'github-runner finished'] = process.argv.slice(2)
  const env = parseEnv(readFileSync(envFile, 'utf8'))
  const { Wallet } = await import('ethers')
  const wallet = new Wallet(env.ALEPH_FORGET_KEY)
  const message = buildForget({
    sender: wallet.address,
    owner: env.ALEPH_OWNER,
    instance: env.ALEPH_INSTANCE,
    reason: `github-runner: ${reason}`
  })
  message.signature = await wallet.signMessage(signaturePayload(message))
  const api = env.ALEPH_API_HOST || 'https://api2.aleph.im'
  const response = await fetch(`${api}/api/v0/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sync: false, message })
  })
  const body = await response.json().catch(() => ({}))
  console.log(`FORGET ${message.item_hash}: HTTP ${response.status} ${body.message_status ?? ''}`)
  if (![200, 202].includes(response.status) || body.message_status === 'rejected') process.exit(1)
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
