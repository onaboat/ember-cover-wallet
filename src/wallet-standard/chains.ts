import {
  SOLANA_DEVNET_CHAIN,
  SOLANA_MAINNET_CHAIN,
} from '@solana/wallet-standard-chains'
import type { IdentifierArray, IdentifierString } from '@wallet-standard/core'

import type { WalletCluster } from '../background/wallet-data-config.ts'

export const EMBER_SOLANA_CHAINS: IdentifierArray = [
  SOLANA_DEVNET_CHAIN,
  SOLANA_MAINNET_CHAIN,
]

export function walletClusterForChain(chain: IdentifierString | undefined): WalletCluster {
  if (chain === undefined || chain === SOLANA_DEVNET_CHAIN) {
    return 'devnet'
  }
  if (chain === SOLANA_MAINNET_CHAIN) {
    return 'mainnet-beta'
  }
  throw new Error(`Ember does not support transaction signing on ${chain}.`)
}
