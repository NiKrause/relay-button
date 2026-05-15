import type { MessageSigner } from '@shared-aleph/shared-types'

type WalletLike = {
  address?: string
  getAddress?(): Promise<string>
  signMessage(message: string): Promise<string>
}

type WalletCtor = new (privateKey: string) => WalletLike

export interface PrivateKeyIdentity {
  address: string
  signer: MessageSigner
}

function ensureWalletAddress(wallet: WalletLike): Promise<string> | string {
  if (typeof wallet.address === 'string' && wallet.address.trim()) return wallet.address
  if (typeof wallet.getAddress === 'function') return wallet.getAddress()
  throw new Error('The provided wallet implementation does not expose an address.')
}

async function loadWalletCtor(options: { walletCtor?: WalletCtor } = {}): Promise<WalletCtor> {
  return (
    options.walletCtor ??
    (await import('ethers').then((module) => module.Wallet).catch(() => {
      throw new Error('ethers is required to create the default Node private-key signer.')
    }))
  )
}

export async function createPrivateKeySigner(
  privateKey: string,
  options: {
    walletCtor?: WalletCtor
  } = {}
): Promise<MessageSigner> {
  const Wallet = await loadWalletCtor(options)

  return async (_sender, payload) => {
    const wallet = new Wallet(privateKey)
    return wallet.signMessage(payload)
  }
}

export async function createPrivateKeyIdentity(
  privateKey: string,
  options: {
    walletCtor?: WalletCtor
  } = {}
): Promise<PrivateKeyIdentity> {
  const Wallet = await loadWalletCtor(options)
  const wallet = new Wallet(privateKey)
  const address = await ensureWalletAddress(wallet)

  return {
    address,
    signer: async (_sender, payload) => wallet.signMessage(payload)
  }
}
