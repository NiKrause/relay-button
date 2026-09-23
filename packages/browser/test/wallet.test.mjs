import assert from 'node:assert/strict'
import test from 'node:test'

import { connectWallet, getEthereumProvider, personalSign, watchWallet } from '../dist/index.js'

function injectedProvider(provider) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'window')
  const previous = globalThis.window
  globalThis.window = { ethereum: provider }
  return () => {
    if (had) {
      globalThis.window = previous
    } else {
      delete globalThis.window
    }
  }
}

function walletProvider({ accounts = ['0xabc'], chainId = '0x1', isMetaMask = true } = {}) {
  const calls = []
  return {
    isMetaMask,
    calls,
    async request(args) {
      calls.push(args.method)
      if (args.method === 'eth_requestAccounts') return accounts
      if (args.method === 'eth_chainId') return chainId
      return null
    }
  }
}

test('getEthereumProvider returns null when the page has no injected wallet', () => {
  assert.equal(getEthereumProvider(), null)
})

test('getEthereumProvider returns the injected wallet', () => {
  const provider = walletProvider()
  const restore = injectedProvider(provider)
  try {
    assert.equal(getEthereumProvider(), provider)
  } finally {
    restore()
  }
})

test('connectWallet asks for accounts and the chain, and reports both', async () => {
  const provider = walletProvider({ accounts: ['0xABC'], chainId: '0x2105' })

  const state = await connectWallet(provider)

  assert.deepEqual(provider.calls, ['eth_requestAccounts', 'eth_chainId'])
  assert.deepEqual(state, {
    connected: true,
    address: '0xABC',
    chainId: '0x2105',
    isMetaMask: true
  })
})

test('connectWallet normalises the address when a normaliser is supplied', async () => {
  const provider = walletProvider({ accounts: ['0xabc'] })

  const state = await connectWallet(provider, { normaliseAddress: (address) => address.toUpperCase() })

  assert.equal(state.address, '0XABC')
})

test('connectWallet reports a wallet that returned no account as unconnected', async () => {
  let normalised = 0
  const provider = walletProvider({ accounts: [] })

  const state = await connectWallet(provider, {
    normaliseAddress: (address) => {
      normalised += 1
      return address
    }
  })

  assert.equal(state.connected, false)
  assert.equal(state.address, null)
  assert.equal(state.chainId, '0x1')
  assert.equal(normalised, 0)
})

test('connectWallet reports a wallet that is not MetaMask', async () => {
  const state = await connectWallet(walletProvider({ isMetaMask: false }))

  assert.equal(state.isMetaMask, false)
})

test('connectWallet falls back to the injected wallet', async () => {
  const provider = walletProvider({ accounts: ['0xdef'] })
  const restore = injectedProvider(provider)
  try {
    const state = await connectWallet()
    assert.equal(state.address, '0xdef')
  } finally {
    restore()
  }
})

test('connectWallet refuses when there is no wallet at all', async () => {
  await assert.rejects(connectWallet(null), /MetaMask provider not found\./)
})

test('watchWallet subscribes to both events and unsubscribes from both', () => {
  const events = []
  const provider = {
    on(event, listener) {
      events.push(['on', event, listener])
    },
    removeListener(event, listener) {
      events.push(['off', event, listener])
    }
  }
  const onChange = () => {}

  const stop = watchWallet(onChange, provider)

  assert.deepEqual(
    events.map(([kind, event]) => `${kind} ${event}`),
    ['on accountsChanged', 'on chainChanged']
  )

  stop()

  assert.deepEqual(
    events.map(([kind, event]) => `${kind} ${event}`),
    ['on accountsChanged', 'on chainChanged', 'off accountsChanged', 'off chainChanged']
  )
  assert.ok(events.every(([, , listener]) => listener === onChange))
})

test('watchWallet is a no-op for a wallet that emits nothing', () => {
  const stop = watchWallet(() => {}, { async request() {} })

  assert.equal(typeof stop, 'function')
  stop()
})

test('watchWallet is a no-op when there is no wallet', () => {
  const stop = watchWallet(() => {})

  assert.equal(typeof stop, 'function')
  stop()
})

test('personalSign falls back to the injected wallet', async () => {
  const signed = []
  const restore = injectedProvider({
    async request(args) {
      signed.push(args)
      return '0xsignature'
    }
  })

  try {
    const signature = await personalSign('0xabc', 'hi')

    assert.equal(signature, '0xsignature')
    assert.deepEqual(signed, [{ method: 'personal_sign', params: ['0x6869', '0xabc'] }])
  } finally {
    restore()
  }
})
