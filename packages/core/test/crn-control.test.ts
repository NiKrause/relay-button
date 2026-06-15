import test from 'node:test'
import assert from 'node:assert/strict'

import { eraseInstanceOnCrn } from '../src/crn-control.ts'

test('eraseInstanceOnCrn signs the CRN control request with aleph-rs-compatible headers', async () => {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = []

  const result = await eraseInstanceOnCrn({
    sender: '0x1234000000000000000000000000000000000000',
    signer: async () => '0xsigned-pubkey',
    instanceHash: 'a'.repeat(64),
    crnUrl: 'https://crn.example.com/',
    fetch: async (url, init) => {
      requests.push({ url: String(url), init })
      return {
        ok: true,
        status: 200,
        async json() {
          return {}
        },
      }
    },
  })

  assert.equal(result.status, 'erased')
  assert.equal(result.source, 'provided')
  assert.equal(result.crnUrl, 'https://crn.example.com')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, `https://crn.example.com/control/machine/${'a'.repeat(64)}/erase`)
  assert.equal(requests[0].init?.method, 'POST')

  const headers = requests[0].init?.headers as Record<string, string>
  const signedPubKey = JSON.parse(headers['X-SignedPubKey'])
  const signedOperation = JSON.parse(headers['X-SignedOperation'])

  assert.equal(signedPubKey.sender, '0x1234000000000000000000000000000000000000')
  assert.equal(signedPubKey.signature, '0xsigned-pubkey')
  assert.equal(signedPubKey.content.domain, 'crn.example.com')

  const signedPubKeyPayload = JSON.parse(Buffer.from(signedPubKey.payload, 'hex').toString('utf8'))
  assert.equal(signedPubKeyPayload.alg, 'ECDSA')
  assert.equal(signedPubKeyPayload.domain, 'crn.example.com')
  assert.equal(signedPubKeyPayload.address, '0x1234000000000000000000000000000000000000')
  assert.equal(signedPubKeyPayload.chain, 'ETH')
  assert.equal(signedPubKeyPayload.pubkey.kty, 'EC')
  assert.equal(signedPubKeyPayload.pubkey.crv, 'P-256')

  const signedOperationPayload = JSON.parse(Buffer.from(signedOperation.payload, 'hex').toString('utf8'))
  assert.equal(signedOperationPayload.domain, 'crn.example.com')
  assert.equal(signedOperationPayload.method, 'POST')
  assert.equal(signedOperationPayload.path, `\/control\/machine\/${'a'.repeat(64)}\/erase`.replace(/\\/g, ''))
  assert.match(signedOperation.signature, /^[a-f0-9]{128}$/)
})
