import type { EthereumProviderLike, EthereumTransactionRequest } from './types'
import { getEthereumProvider } from './wallet'

function ensureHexQuantity(value: bigint): `0x${string}` {
  return `0x${value.toString(16)}`
}

function assertProvider(provider: EthereumProviderLike | null | undefined): asserts provider is EthereumProviderLike {
  if (!provider) {
    throw new Error('MetaMask provider not found.')
  }
}

export async function ethCall(
  to: string,
  data: `0x${string}`,
  provider: EthereumProviderLike | null | undefined
): Promise<string> {
  assertProvider(provider)

  return provider.request<string>({
    method: 'eth_call',
    params: [
      {
        to,
        data
      },
      'latest'
    ]
  })
}

export async function sendTransaction(
  tx: EthereumTransactionRequest,
  provider: EthereumProviderLike | null | undefined
): Promise<string> {
  assertProvider(provider)

  return provider.request<string>({
    method: 'eth_sendTransaction',
    params: [
      {
        from: tx.from,
        to: tx.to,
        data: tx.data,
        value: tx.value != null ? ensureHexQuantity(tx.value) : undefined
      }
    ]
  })
}

export async function personalSign(
  address: string,
  message: string,
  provider: EthereumProviderLike | null | undefined = getEthereumProvider()
): Promise<string> {
  assertProvider(provider)

  const hexMessage = `0x${Array.from(new TextEncoder().encode(message))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`

  return provider.request<string>({
    method: 'personal_sign',
    params: [hexMessage, address]
  })
}
