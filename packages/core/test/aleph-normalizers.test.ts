import test from 'node:test'
import assert from 'node:assert/strict'

import {
  describeRejectedDeployment,
  extractProxyUrl,
  extractReferenceHashes,
  messageTypeFromEnvelope,
  normalizeExecution,
  normalizeMessageStatus,
  normalizeProxyUrl
} from '../src/aleph-normalizers.ts'

test('normalizeMessageStatus maps known statuses and defaults to unknown', () => {
  assert.equal(normalizeMessageStatus('processed'), 'processed')
  assert.equal(normalizeMessageStatus('PENDING'), 'pending')
  assert.equal(normalizeMessageStatus('weird'), 'unknown')
  assert.equal(normalizeMessageStatus(undefined), 'unknown')
})

test('normalizeProxyUrl adds https when the value is a bare hostname', () => {
  assert.equal(normalizeProxyUrl('relay.example.com'), 'https://relay.example.com')
  assert.equal(normalizeProxyUrl('https://relay.example.com'), 'https://relay.example.com')
  assert.equal(normalizeProxyUrl(''), null)
})

test('messageTypeFromEnvelope reads direct, nested, and messages-array types', () => {
  assert.equal(messageTypeFromEnvelope({ type: 'store' }), 'STORE')
  assert.equal(messageTypeFromEnvelope({ message: { type: 'instance' } }), 'INSTANCE')
  assert.equal(messageTypeFromEnvelope({ messages: [{ type: 'aggregate' }] }), 'AGGREGATE')
})

test('extractReferenceHashes returns only string reference hashes from details.errors', () => {
  assert.deepEqual(extractReferenceHashes({ errors: ['abc', 1, 'def'] }), ['abc', 'def'])
  assert.deepEqual(extractReferenceHashes(null), [])
})

test('describeRejectedDeployment explains pending rootfs references clearly', () => {
  const message = describeRejectedDeployment(
    { error_code: 5, details: {} },
    [{ itemHash: 'rootfsHash', status: 'pending', type: 'STORE' }],
    'rootfsHash'
  )

  assert.match(message, /rootfs STORE message rootfsHash is still pending/i)
})

test('describeRejectedDeployment falls back to referenced hashes from error details', () => {
  const message = describeRejectedDeployment(
    { error_code: 42, details: { errors: ['hashA', 'hashB'] } },
    [],
    undefined
  )

  assert.match(message, /error 42/i)
  assert.match(message, /hashA, hashB/)
})

test('extractProxyUrl prefers networking and web access candidates', () => {
  assert.equal(
    extractProxyUrl(
      { networking: { proxy_hostname: 'relay.example.com' } },
      { proxy_hostname: 'relay.example.com' }
    ),
    'https://relay.example.com'
  )

  assert.equal(
    extractProxyUrl(
      { web_access: { url: 'https://proxy.example.com' } },
      {}
    ),
    'https://proxy.example.com'
  )
})

test('normalizeExecution produces v2 execution shapes with mapped ports and proxy url', () => {
  const result = normalizeExecution(
    {
      networking: {
        host_ipv4: '203.0.113.5',
        ipv6_ip: '2001:db8::1',
        mapped_ports: {
          '22': { host: 45678, tcp: true, udp: false }
        },
        proxy_hostname: 'relay.example.com'
      },
      running: true,
      status: {
        started_at: '2026-05-14T00:00:00Z'
      }
    },
    'https://crn.example.com'
  )

  assert.equal(result.version, 'v2')
  assert.equal(result.networking.host_ipv4, '203.0.113.5')
  assert.equal(result.networking.proxy_url, 'https://relay.example.com')
  assert.deepEqual(result.networking.mapped_ports?.['22'], { host: 45678, tcp: true, udp: false })
})

test('normalizeExecution produces v1 execution shapes when only legacy fields exist', () => {
  const result = normalizeExecution(
    {
      networking: {
        ipv4: '203.0.113.7',
        ipv6: '2001:db8::7'
      }
    },
    'https://crn.example.com'
  )

  assert.equal(result.version, 'v1')
  assert.equal(result.networking.ipv4, '203.0.113.7')
  assert.equal(result.networking.ipv6, '2001:db8::7')
})
