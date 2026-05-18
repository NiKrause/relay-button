import assert from 'node:assert/strict'
import test from 'node:test'

import { fetchBalance, fetchCrns, fetchInstances, normalizeMessageStatus } from '../dist/index.js'

test('normalizeMessageStatus keeps supported statuses and maps unknown values', () => {
  assert.equal(normalizeMessageStatus('processed'), 'processed')
  assert.equal(normalizeMessageStatus('PENDING'), 'pending')
  assert.equal(normalizeMessageStatus('bad'), 'unknown')
  assert.equal(normalizeMessageStatus(null), 'unknown')
})

test('fetchBalance requests the public balance API path', async () => {
  const originalFetch = globalThis.fetch

  try {
    let capturedUrl = ''
    globalThis.fetch = async (input) => {
      capturedUrl = String(input)
      return new Response(
        JSON.stringify({
          address: '0xabc',
          balance: '1',
          locked_amount: '0',
          credit_balance: 2
        }),
        { status: 200 }
      )
    }

    const balance = await fetchBalance('0xabc')
    assert.equal(balance.credit_balance, 2)
    assert.match(capturedUrl, /\/api\/v0\/addresses\/0xabc\/balance/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('fetchCrns requests the CRN list with inactive filtering enabled', async () => {
  const originalFetch = globalThis.fetch

  try {
    let capturedUrl = ''
    globalThis.fetch = async (input) => {
      capturedUrl = String(input)
      return new Response(JSON.stringify({ crns: [{ hash: 'abc', name: 'CRN', address: 'https://crn.example' }] }), {
        status: 200
      })
    }

    const crns = await fetchCrns('https://crns-list.aleph.sh/crns.json')
    const url = new URL(capturedUrl)
    assert.equal(crns.length, 1)
    assert.equal(url.searchParams.get('filter_inactive'), 'true')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('fetchInstances requests instance messages and normalizes confirmed items to processed', async () => {
  const originalFetch = globalThis.fetch

  try {
    let capturedUrl = ''
    globalThis.fetch = async (input) => {
      capturedUrl = String(input)
      return new Response(
        JSON.stringify({
          messages: [{ item_hash: 'a'.repeat(64), type: 'INSTANCE', confirmed: true, status: null }]
        }),
        { status: 200 }
      )
    }

    const instances = await fetchInstances('0xabc')
    const url = new URL(capturedUrl)
    assert.equal(url.searchParams.get('msgTypes'), 'INSTANCE')
    assert.equal(url.searchParams.get('addresses'), '0xabc')
    assert.equal(url.searchParams.get('message_statuses'), 'processed,pending,rejected,removing')
    assert.deepEqual(instances, [
      {
        item_hash: 'a'.repeat(64),
        type: 'INSTANCE',
        confirmed: true,
        status: 'processed'
      }
    ])
  } finally {
    globalThis.fetch = originalFetch
  }
})
