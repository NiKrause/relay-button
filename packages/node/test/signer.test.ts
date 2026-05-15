import test from 'node:test'
import assert from 'node:assert/strict'

import { createPrivateKeyIdentity, createPrivateKeySigner } from '../src/signer.ts'

test('createPrivateKeySigner uses the injected wallet constructor', async () => {
  class FakeWallet {
    privateKey: string

    constructor(privateKey: string) {
      this.privateKey = privateKey
    }

    async signMessage(message: string): Promise<string> {
      return `signed:${this.privateKey}:${message}`
    }
  }

  const signer = await createPrivateKeySigner('secret-key', { walletCtor: FakeWallet })
  const signature = await signer('0xabc', 'payload')
  assert.equal(signature, 'signed:secret-key:payload')
})

test('createPrivateKeyIdentity returns the wallet address and signer', async () => {
  class FakeWallet {
    privateKey: string
    address: string

    constructor(privateKey: string) {
      this.privateKey = privateKey
      this.address = '0x1234'
    }

    async signMessage(message: string): Promise<string> {
      return `signed:${this.privateKey}:${message}`
    }
  }

  const identity = await createPrivateKeyIdentity('secret-key', { walletCtor: FakeWallet })
  assert.equal(identity.address, '0x1234')
  assert.equal(await identity.signer(identity.address, 'payload'), 'signed:secret-key:payload')
})
