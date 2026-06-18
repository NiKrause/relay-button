import test from 'node:test'
import assert from 'node:assert/strict'

import { validateUcanStoreBootstrapPackage } from '../src/ucan-store-bootstrap.ts'

test('validateUcanStoreBootstrapPackage accepts a normalized bootstrap package', () => {
  const result = validateUcanStoreBootstrapPackage({
    operatorAddress: '0x1234000000000000000000000000000000000000',
    adminDid: 'did:key:zAdmin',
    serviceDid: 'did:key:zService',
    spaceDid: 'did:key:zSpace',
    rootDelegationProof: 'uEgVjYW5wcm9vZg',
    allowedCapabilities: ['space/blob/add', 'space/blob/list'],
    defaultUserDelegationExpiration: 86400,
    maxUserDelegationExpiration: 604800,
    pwaOrigin: 'https://store.example.com',
    serviceOrigin: 'https://upload.example.com',
  })

  assert.equal(result.valid, true)
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.bootstrapPackage, {
    operatorAddress: '0x1234000000000000000000000000000000000000',
    adminDid: 'did:key:zAdmin',
    serviceDid: 'did:key:zService',
    spaceDid: 'did:key:zSpace',
    rootDelegationProof: 'uEgVjYW5wcm9vZg',
    allowedCapabilities: ['space/blob/add', 'space/blob/list'],
    defaultUserDelegationExpiration: 86400,
    maxUserDelegationExpiration: 604800,
    pwaOrigin: 'https://store.example.com',
    serviceOrigin: 'https://upload.example.com',
  })
})

test('validateUcanStoreBootstrapPackage rejects malformed bootstrap packages', () => {
  const result = validateUcanStoreBootstrapPackage({
    operatorAddress: 'not-an-address',
    adminDid: '',
    serviceDid: 'nope',
    spaceDid: 'also-nope',
    rootDelegationProof: '',
    allowedCapabilities: [],
    defaultUserDelegationExpiration: -1,
    maxUserDelegationExpiration: 10,
    pwaOrigin: 'https://store.example.com/app',
    serviceOrigin: 'upload.example.com',
  })

  assert.equal(result.valid, false)
  assert.equal(result.bootstrapPackage, null)
  assert.ok(
    result.errors.some((entry) =>
      entry.includes('operatorAddress must be a 0x-prefixed 20-byte Ethereum address.'),
    ),
  )
  assert.ok(
    result.errors.some((entry) =>
      entry.includes('adminDid must be a non-empty DID string.'),
    ),
  )
  assert.ok(
    result.errors.some((entry) =>
      entry.includes('allowedCapabilities must contain at least one capability string.'),
    ),
  )
})
