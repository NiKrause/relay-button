import test from 'node:test'
import assert from 'node:assert/strict'

import { extract } from '@ucanto/core/delegation'

import {
  deriveUcanStoreBootstrapPackage,
  shouldDeriveUcanStoreBootstrapPackage
} from '../src/ucan-store-bootstrap.ts'

function decodeMultibaseBase64Proof(proof: string): Uint8Array {
  assert.equal(proof[0], 'm')
  return Uint8Array.from(Buffer.from(proof.slice(1), 'base64'))
}

test('deriveUcanStoreBootstrapPackage deterministically creates a valid root proof', async () => {
  const options = {
    alephPrivateKey: '0x59c6995e998f97a5a0044966f0945382d7d3a2ab6c4b71a0f5f5d5b6d7e8f901',
    operatorAddress: '0x1234000000000000000000000000000000000000',
    serviceDid: 'did:web:ucan-api.nicokrause.com',
    serviceOrigin: 'https://ucan-api.nicokrause.com',
    pwaOrigin: 'https://ucan.nicokrause.com',
    allowedCapabilities: ['space/blob/add', 'upload/add'],
    defaultUserDelegationExpiration: 86400,
    maxUserDelegationExpiration: 604800,
    derivationContext: 'NomadKids/ucan-store|main',
  }

  const first = await deriveUcanStoreBootstrapPackage(options)
  const second = await deriveUcanStoreBootstrapPackage(options)

  assert.deepEqual(second, first)
  assert.equal(first.operatorAddress, options.operatorAddress)
  assert.equal(first.serviceDid, options.serviceDid)
  assert.equal(first.serviceOrigin, options.serviceOrigin)
  assert.equal(first.pwaOrigin, options.pwaOrigin)
  assert.equal(first.spaceDid, first.adminDid)
  assert.match(first.adminDid, /^did:key:/)
  assert.match(first.rootDelegationProof, /^m/)

  const extracted = await extract(
    decodeMultibaseBase64Proof(first.rootDelegationProof)
  )
  assert.ok(extracted.ok)
  const delegation = extracted.ok
  assert.equal(delegation.issuer.did(), first.adminDid)
  assert.equal(delegation.audience.did(), options.serviceDid)
  assert.deepEqual(
    delegation.capabilities.map((capability) => ({
      can: capability.can,
      with: capability.with
    })),
    [
      { can: 'space/blob/add', with: first.spaceDid },
      { can: 'upload/add', with: first.spaceDid }
    ]
  )
})

test('shouldDeriveUcanStoreBootstrapPackage requires opt-in mode and no explicit JSON', () => {
  assert.equal(
    shouldDeriveUcanStoreBootstrapPackage({
      ALEPH_VM_UCAN_STORE_BOOTSTRAP_MODE: 'derive-from-aleph-private-key'
    }),
    true
  )
  assert.equal(
    shouldDeriveUcanStoreBootstrapPackage({
      ALEPH_VM_UCAN_STORE_BOOTSTRAP_MODE: 'derive-from-aleph-private-key',
      ALEPH_VM_UCAN_STORE_BOOTSTRAP_JSON: '{"adminDid":"did:key:zAlready"}'
    }),
    false
  )
  assert.equal(
    shouldDeriveUcanStoreBootstrapPackage({
      ALEPH_VM_UCAN_STORE_BOOTSTRAP_MODE: ''
    }),
    false
  )
})

