import { getAddress } from "viem";
import {
  connectWallet as connectBrowserWallet,
  getEthereumProvider,
  personalSign,
  watchWallet,
} from "../../../browser/src/index.ts";

import type { EthereumProviderLike } from "../../../browser/src/types.ts";
import type { SponsorRelayWalletState } from "./types";

export type { EthereumProviderLike };
export { getEthereumProvider, personalSign, watchWallet };

export function toChecksumAddress(address: string): string {
  try {
    return getAddress(address);
  } catch {
    throw new Error("Invalid EVM address.");
  }
}

/**
 * The wallet helpers live in `@le-space/browser`, which carries no runtime
 * dependencies. Checksumming needs viem, so this package supplies it.
 */
export async function connectWallet(
  provider = getEthereumProvider(),
): Promise<SponsorRelayWalletState> {
  return connectBrowserWallet(provider, {
    normaliseAddress: toChecksumAddress,
  });
}
