import type { EthereumProviderLike, WalletState } from './types'

export interface ConnectWalletOptions {
  /**
   * Applied to the address the wallet reports. This package has no runtime
   * dependencies, so checksumming is the caller's to supply — `@le-space/ui`
   * passes viem's `getAddress`.
   */
  normaliseAddress?: (address: string) => string
}

export function getEthereumProvider(): EthereumProviderLike | null {
  return (globalThis as { window?: { ethereum?: EthereumProviderLike } }).window?.ethereum ?? null
}

export async function connectWallet(
  provider: EthereumProviderLike | null | undefined = getEthereumProvider(),
  options: ConnectWalletOptions = {}
): Promise<WalletState> {
  if (!provider) {
    throw new Error('MetaMask provider not found.')
  }

  const accounts = await provider.request<string[]>({ method: 'eth_requestAccounts' })
  const chainId = await provider.request<string>({ method: 'eth_chainId' })
  const account = accounts?.[0]
  const address = account ? (options.normaliseAddress?.(account) ?? account) : null

  return {
    connected: Boolean(address),
    address,
    chainId,
    isMetaMask: Boolean(provider.isMetaMask)
  }
}

export function watchWallet(
  onChange: () => void,
  provider: EthereumProviderLike | null | undefined = getEthereumProvider()
): () => void {
  if (!provider?.on || !provider?.removeListener) {
    return () => {}
  }

  provider.on('accountsChanged', onChange)
  provider.on('chainChanged', onChange)

  return () => {
    provider.removeListener?.('accountsChanged', onChange)
    provider.removeListener?.('chainChanged', onChange)
  }
}
