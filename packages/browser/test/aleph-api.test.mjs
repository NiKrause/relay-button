import assert from 'node:assert/strict'
import test from 'node:test'

import {
  fetchBalance,
  fetchCrns,
  fetchInstances,
  fetchMessageEnvelope,
  inspectDeploymentResult,
  normalizeMessageStatus,
  waitForDeploymentResult
} from '../dist/index.js'

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

test('fetchMessageEnvelope returns null for a missing message', async () => {
  const originalFetch = globalThis.fetch

  try {
    globalThis.fetch = async () => new Response('', { status: 404 })
    const payload = await fetchMessageEnvelope('a'.repeat(64))
    assert.equal(payload, null)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('inspectDeploymentResult resolves related references and rejection reason', async () => {
  const originalFetch = globalThis.fetch

  try {
    globalThis.fetch = async (input) => {
      const url = String(input)

      if (url.startsWith(`https://api2.aleph.im/api/v0/messages/${'a'.repeat(64)}`)) {
        return new Response(
          JSON.stringify({
            status: 'rejected',
            error_code: 13,
            details: { errors: ['b'.repeat(64)] }
          }),
          { status: 200 }
        )
      }

      if (url.startsWith(`https://api2.aleph.im/api/v0/messages/${'b'.repeat(64)}`)) {
        return new Response(
          JSON.stringify({
            status: 'pending',
            type: 'store'
          }),
          { status: 200 }
        )
      }

      throw new Error(`Unexpected URL ${url}`)
    }

    const result = await inspectDeploymentResult('a'.repeat(64), 'b'.repeat(64))
    assert.equal(result.status, 'rejected')
    assert.equal(result.errorCode, 13)
    assert.equal(result.references.length, 1)
    assert.equal(result.references[0].status, 'pending')
    assert.match(result.rejectionReason ?? '', /still pending/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('waitForDeploymentResult polls until the message reaches a terminal state', async () => {
  const originalFetch = globalThis.fetch
  const originalSetTimeout = globalThis.setTimeout

  try {
    let calls = 0
    globalThis.fetch = async () => {
      calls += 1
      return new Response(JSON.stringify({ status: calls === 1 ? 'pending' : 'processed' }), { status: 200 })
    }
    globalThis.setTimeout = ((fn) => {
      fn()
      return 0
    })

    const result = await waitForDeploymentResult('a'.repeat(64), undefined, undefined, 3, 1)
    assert.equal(result.status, 'processed')
    assert.equal(calls, 2)
  } finally {
    globalThis.fetch = originalFetch
    globalThis.setTimeout = originalSetTimeout
  }
})
